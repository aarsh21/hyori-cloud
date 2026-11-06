use super::{account, folder, names, setup, share, support};
use hyori_server::db::sql;
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use support::{Postgres, Reply, TestServer};

/// Browser replacement semantics: apply every Set-Cookie separately by name, never replace the jar
/// with the headers of the last response. These fixtures use the same host and Path=/ throughout.
#[derive(Clone, Default)]
pub(super) struct CookieJar(BTreeMap<String, String>);
impl CookieJar {
    pub(super) fn apply(&mut self, reply: &Reply) {
        for cookie in &reply.cookies {
            let (name, value) = cookie.split(';').next().unwrap().split_once('=').unwrap();
            assert!(cookie.contains("HttpOnly"));
            assert!(cookie.contains("SameSite=Strict"));
            assert!(cookie.contains("Path=/"));
            assert!(!cookie.contains("Domain="));
            if cookie
                .split(';')
                .any(|attribute| attribute.trim() == "Max-Age=0")
            {
                self.0.remove(name);
            } else {
                self.0.insert(name.into(), value.into());
            }
        }
    }
    pub(super) fn header(&self) -> String {
        self.0
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ")
    }
    pub(super) fn len(&self) -> usize {
        self.0.len()
    }
}

#[tokio::test]
#[ignore = "real HTTP and isolated PostgreSQL, 1001 incoming direct shares across many deep owner trees"]
async fn incoming_share_volume_never_locks_out_owned_operations() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = setup(&server, &pg.config).await;
    let recipient = account(&server, &admin, "recipient").await;
    let owned = folder(&server, &recipient.cookie, None, "Mine").await;
    // Twenty independent owners with fifty levels each. There is no global recipient limit in the
    // product API; seed the first thousand and cross the old failure threshold through shares.create.
    server
        .state
        .db
        .execute_raw(sql(
            "INSERT INTO hyori_users(id,email,name,role,quota_bytes)
         SELECT 'issuer-'||n,'issuer-'||n||'@example.test','Issuer '||n,'user',1000000
         FROM generate_series(1,20) n",
            vec![],
        ))
        .await
        .unwrap();
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,mime_type,ancestor_ids)
         SELECT 'tree-'||owner||'-'||lpad(depth::text,2,'0'),'issuer-'||owner,
                CASE WHEN depth=0 THEN NULL ELSE 'tree-'||owner||'-'||lpad((depth-1)::text,2,'0') END,
                'Depth-'||owner||'-'||depth,'folder','inode/directory',
                COALESCE((SELECT jsonb_agg('tree-'||owner||'-'||lpad(p::text,2,'0') ORDER BY p)
                          FROM generate_series(0,depth-1) p),'[]'::jsonb)
         FROM generate_series(1,20) owner CROSS JOIN generate_series(0,49) depth", vec![])).await.unwrap();
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_shares(id,item_id,issuer_id,recipient_id,public,role)
         SELECT 'share-'||id,id,owner_id,$1,false,
                CASE WHEN id LIKE '%-25' THEN 'editor' WHEN id LIKE '%-00' THEN 'contributor' ELSE 'viewer' END
         FROM hyori_items WHERE owner_id LIKE 'issuer-%'", vec![recipient.id.clone().into()])).await.unwrap();
    server
        .rpc("files.list", json!({}), Some(&recipient.cookie))
        .await
        .value();
    let hidden = folder(&server, &admin.cookie, None, "Hidden ancestor").await;
    let boundary = folder(&server, &admin.cookie, Some(&hidden), "Boundary share").await;
    let share_id = share(&server, &admin, &boundary, &recipient, "viewer").await;
    let count = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT count(*) AS count FROM hyori_shares WHERE recipient_id=$1",
            vec![recipient.id.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(count.try_get::<i64>("", "count").unwrap(), 1001);

    assert!(
        names(
            &server
                .rpc("files.list", json!({}), Some(&recipient.cookie))
                .await
        )
        .contains(&"Mine".to_owned())
    );
    assert_eq!(
        server
            .rpc(
                "files.rename",
                json!({"id":owned,"name":"Still mine"}),
                Some(&recipient.cookie)
            )
            .await
            .value()["name"],
        "Still mine"
    );
    folder(&server, &recipient.cookie, Some(&owned), "Still writable").await;
    folder(&server, &recipient.cookie, None, "New root").await;
    for operation in ["files.versions", "shares.list"] {
        let input = if operation == "shares.list" {
            json!({"itemId":owned})
        } else {
            json!({"id":owned})
        };
        server
            .rpc(operation, input, Some(&recipient.cookie))
            .await
            .value();
    }
    server
        .rpc(
            "files.move",
            json!({"id":owned,"parentId":null}),
            Some(&recipient.cookie),
        )
        .await
        .value();
    server
        .rpc("files.trash", json!({"id":owned}), Some(&recipient.cookie))
        .await
        .value();
    server
        .rpc(
            "files.restore",
            json!({"id":owned}),
            Some(&recipient.cookie),
        )
        .await
        .value();

    // Discovery is keyset-paginated, including direct roots that also have inherited access.
    let mut cursor = Value::Null;
    let mut ids = BTreeSet::new();
    loop {
        let reply = server
            .rpc(
                "files.list",
                json!({"view":"shared","limit":73,"cursor":cursor}),
                Some(&recipient.cookie),
            )
            .await;
        for item in reply.value()["items"].as_array().unwrap() {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
        }
        cursor = reply.value()["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(ids.len(), 1001);
    let deep = server
        .rpc(
            "files.list",
            json!({"parentId":"tree-20-49"}),
            Some(&recipient.cookie),
        )
        .await;
    assert_eq!(deep.value()["folder"]["access"]["role"], "editor");
    assert_eq!(deep.value()["breadcrumbs"].as_array().unwrap().len(), 50);
    let search = server
        .rpc(
            "files.list",
            json!({"search":"Depth-20-49"}),
            Some(&recipient.cookie),
        )
        .await;
    assert_eq!(search.value()["items"][0]["access"]["role"], "editor");
    let early = server
        .rpc(
            "files.list",
            json!({"parentId":"tree-20-10"}),
            Some(&recipient.cookie),
        )
        .await;
    assert_eq!(early.value()["folder"]["access"]["role"], "contributor");
    folder(
        &server,
        &recipient.cookie,
        Some("tree-20-10"),
        "Contribution",
    )
    .await;
    server
        .rpc(
            "files.rename",
            json!({"id":"tree-20-10","name":"Denied"}),
            Some(&recipient.cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "files.rename",
            json!({"id":"tree-20-49","name":"Edited descendant"}),
            Some(&recipient.cookie),
        )
        .await
        .value();
    let direct = server
        .rpc(
            "files.list",
            json!({"parentId":boundary}),
            Some(&recipient.cookie),
        )
        .await;
    assert_eq!(direct.value()["folder"]["access"]["role"], "viewer");
    assert_eq!(direct.value()["breadcrumbs"].as_array().unwrap().len(), 1);
    server
        .rpc(
            "files.list",
            json!({"parentId":hidden}),
            Some(&recipient.cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "files.rename",
            json!({"id":boundary,"name":"Denied"}),
            Some(&recipient.cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":boundary,"name":"Denied"}),
            Some(&recipient.cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc("shares.revoke", json!({"id":share_id}), Some(&admin.cookie))
        .await
        .value();
    server
        .rpc(
            "files.list",
            json!({"parentId":boundary}),
            Some(&recipient.cookie),
        )
        .await
        .error(403, "access.denied");
}

#[tokio::test]
#[ignore = "two independent AppState HTTP servers, isolated PostgreSQL, concurrent browser cookie merge"]
async fn parallel_public_grants_merge_from_empty_and_existing_jars_and_retain_sixteen() {
    let pg = Postgres::start().await;
    let first = TestServer::start(pg.config.clone()).await;
    let second = TestServer::start(pg.config.clone()).await;
    let owner = setup(&first, &pg.config).await;
    let mut folders = Vec::new();
    let mut links = Vec::new();
    for index in 0..19 {
        let id = folder(&first, &owner.cookie, None, &format!("Scope-{index}")).await;
        let mut input = json!({"itemId":id,"public":true,"role":"viewer"});
        if index == 1 || index == 3 {
            input["password"] = json!("public link password");
        }
        let reply = first.rpc("shares.create", input, Some(&owner.cookie)).await;
        let token = reply.value()["url"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap()
            .to_owned();
        folders.push(id);
        links.push(token);
    }
    let mut jar = CookieJar::default();
    // Both requests receive the identical empty Cookie state, and hit independent connection pools.
    let (a, b) = tokio::join!(
        first.rpc("shares.resolve", json!({"token":links[0]}), None),
        second.rpc(
            "shares.unlock",
            json!({"token":links[1],"password":"public link password"}),
            None
        )
    );
    a.value();
    b.value();
    jar.apply(&a);
    jar.apply(&b);
    assert_eq!(jar.len(), 2);
    let mut reverse = CookieJar::default();
    reverse.apply(&b);
    reverse.apply(&a);
    assert_eq!(jar.header(), reverse.header());
    for id in &folders[..2] {
        first
            .rpc("files.list", json!({"parentId":id}), Some(&jar.header()))
            .await
            .value();
        second
            .rpc("files.list", json!({"parentId":id}), Some(&jar.header()))
            .await
            .value();
    }
    let incoming = jar.header();
    let (a, b) = tokio::join!(
        first.rpc("shares.resolve", json!({"token":links[2]}), Some(&incoming)),
        second.rpc(
            "shares.unlock",
            json!({"token":links[3],"password":"public link password"}),
            Some(&incoming)
        )
    );
    a.value();
    b.value();
    jar.apply(&b);
    jar.apply(&a);
    assert_eq!(jar.len(), 4);
    for id in &folders[..4] {
        second
            .rpc("files.list", json!({"parentId":id}), Some(&jar.header()))
            .await
            .value();
    }
    // Two refresh responses for the same share replace one name, and either arriving last works.
    let incoming = jar.header();
    let (a, b) = tokio::join!(
        first.rpc("shares.resolve", json!({"token":links[1]}), Some(&incoming)),
        second.rpc("shares.resolve", json!({"token":links[1]}), Some(&incoming))
    );
    a.value();
    b.value();
    jar.apply(&a);
    jar.apply(&b);
    assert_eq!(jar.len(), 4);
    second
        .rpc(
            "files.list",
            json!({"parentId":folders[1]}),
            Some(&jar.header()),
        )
        .await
        .value();
    jar.apply(&a);
    first
        .rpc(
            "files.list",
            json!({"parentId":folders[1]}),
            Some(&jar.header()),
        )
        .await
        .value();

    // An unrelated response must not delete an expired cookie that another tab just refreshed.
    first
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_grants SET expires_at=now()-interval '1 second'
         WHERE share_id IN (SELECT id FROM hyori_shares WHERE item_id=$1)",
            vec![folders[0].clone().into()],
        ))
        .await
        .unwrap();
    let incoming = jar.header();
    let (a, b) = tokio::join!(
        first.rpc("shares.resolve", json!({"token":links[0]}), Some(&incoming)),
        second.rpc("shares.resolve", json!({"token":links[2]}), Some(&incoming))
    );
    a.value();
    b.value();
    assert_eq!(b.cookies.len(), 1);
    jar.apply(&a);
    jar.apply(&b);
    assert_eq!(jar.len(), 4);
    second
        .rpc(
            "files.list",
            json!({"parentId":folders[0]}),
            Some(&jar.header()),
        )
        .await
        .value();

    for token in &links[4..16] {
        let reply = first
            .rpc(
                "shares.resolve",
                json!({"token":token}),
                Some(&jar.header()),
            )
            .await;
        reply.value();
        jar.apply(&reply);
    }
    assert_eq!(jar.len(), 16);
    // Refreshing at capacity does not evict any other scope.
    let refreshed = second
        .rpc(
            "shares.resolve",
            json!({"token":links[0]}),
            Some(&jar.header()),
        )
        .await;
    refreshed.value();
    jar.apply(&refreshed);
    assert_eq!(jar.len(), 16);
    for id in &folders[..16] {
        first
            .rpc("files.list", json!({"parentId":id}), Some(&jar.header()))
            .await
            .value();
    }
    // Concurrent additions at capacity both set only their own name and evict observed oldest.
    // The merged jar may temporarily have 17 cookies; no request may use more than 16 active grants.
    let incoming = jar.header();
    let (a, b) = tokio::join!(
        first.rpc(
            "shares.resolve",
            json!({"token":links[16]}),
            Some(&incoming)
        ),
        second.rpc(
            "shares.resolve",
            json!({"token":links[17]}),
            Some(&incoming)
        )
    );
    a.value();
    b.value();
    assert_eq!(a.cookies.len(), 2);
    assert_eq!(b.cookies.len(), 2);
    jar.apply(&a);
    jar.apply(&b);
    assert_eq!(jar.len(), 17);
    let shared = first
        .rpc("files.list", json!({"view":"shared"}), Some(&jar.header()))
        .await;
    assert_eq!(shared.value()["items"].as_array().unwrap().len(), 16);
    let final_open = second
        .rpc(
            "shares.resolve",
            json!({"token":links[18]}),
            Some(&jar.header()),
        )
        .await;
    final_open.value();
    jar.apply(&final_open);
    assert_eq!(jar.len(), 16);
    assert_eq!(final_open.cookies.len(), 3);
    for id in &folders[16..] {
        first
            .rpc("files.list", json!({"parentId":id}), Some(&jar.header()))
            .await
            .value();
    }
    first
        .rpc(
            "files.list",
            json!({"parentId":folders[0]}),
            Some(&jar.header()),
        )
        .await
        .value();
    // Renaming a cookie cannot turn its token into authority for a different link.
    let first_cookie = refreshed.credential();
    let (_, token) = first_cookie.split_once('=').unwrap();
    let forged = format!("hyori_grant_{}={token}", "f".repeat(64));
    second
        .rpc("files.list", json!({"parentId":folders[0]}), Some(&forged))
        .await
        .value();
    second
        .rpc("files.list", json!({"parentId":folders[18]}), Some(&forged))
        .await
        .error(403, "access.denied");

    // Owner capabilities win, but the projected grant role must still follow current ancestry/trash.
    let owner_cookie = format!("{}; {}", owner.cookie, jar.header());
    let created = first
        .rpc(
            "files.createFolder",
            json!({"parentId":folders[0],"name":"Projection"}),
            Some(&owner_cookie),
        )
        .await;
    assert_eq!(created.value()["access"]["role"], "viewer");
    assert_eq!(created.value()["access"]["canUpload"], true);
    let id = created.value()["id"].clone();
    let moved = first
        .rpc(
            "files.move",
            json!({"id":id,"parentId":null}),
            Some(&owner_cookie),
        )
        .await;
    assert_eq!(moved.value()["access"]["role"], Value::Null);
    let moved = first
        .rpc(
            "files.move",
            json!({"id":id,"parentId":folders[0]}),
            Some(&owner_cookie),
        )
        .await;
    assert_eq!(moved.value()["access"]["role"], "viewer");
    let trashed = first
        .rpc("files.trash", json!({"id":id}), Some(&owner_cookie))
        .await;
    assert_eq!(trashed.value()["access"]["role"], Value::Null);
    let restored = first
        .rpc("files.restore", json!({"id":id}), Some(&owner_cookie))
        .await;
    assert_eq!(restored.value()["access"]["role"], "viewer");
}
