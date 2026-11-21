#[path = "support/authorization_lifecycle.rs"]
mod authorization_lifecycle;
#[path = "support/file_sorting.rs"]
mod file_sorting;
#[path = "support/link_capability.rs"]
mod link_capability;
#[path = "support/metadata_listing.rs"]
mod metadata_listing;
mod support;
use authorization_lifecycle::CookieJar;
#[path = "../src/features/files/transaction_tests.rs"]
mod transaction_tests;
use hyori_server::{
    auth::{digest, random_token},
    db::sql,
};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::{Value, json};
use support::{Postgres, TestServer};

struct Account {
    id: String,
    cookie: String,
}
async fn setup(server: &TestServer, config: &hyori_server::config::Config) -> Account {
    let reply = server.rpc("auth.setup", json!({"email":"admin@example.test","name":"Admin","password":"correct horse battery staple","setupToken":config.setup_token}), None).await;
    Account {
        id: reply.value()["id"].as_str().unwrap().into(),
        cookie: reply.credential(),
    }
}
async fn account(server: &TestServer, admin: &Account, name: &str) -> Account {
    let email = format!("{name}@example.test");
    let reply = server
        .rpc(
            "admin.createUser",
            json!({"email":email,"name":name,"password":"correct horse battery staple"}),
            Some(&admin.cookie),
        )
        .await;
    let id = reply.value()["id"].as_str().unwrap().into();
    let login = server
        .rpc(
            "auth.login",
            json!({"email":email,"password":"correct horse battery staple"}),
            None,
        )
        .await;
    login.value();
    Account {
        id,
        cookie: login.credential(),
    }
}
async fn folder(server: &TestServer, cookie: &str, parent: Option<&str>, name: &str) -> String {
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":parent,"name":name}),
            Some(cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn share(
    server: &TestServer,
    owner: &Account,
    item: &str,
    recipient: &Account,
    role: &str,
) -> String {
    server
        .rpc(
            "shares.create",
            json!({"itemId":item,"recipientId":recipient.id,"public":false,"role":role}),
            Some(&owner.cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn names(reply: &support::Reply) -> Vec<String> {
    reply.value()["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap().into())
        .collect()
}
// Metadata-only fixtures: no RustFS server or binary transfer is claimed by this suite.
async fn seed_file(server: &TestServer, owner: &Account, parent: &str, name: &str) -> String {
    let id = random_token();
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,object_key,ancestor_ids) SELECT $1,$2,$3,$4,'file',10,'image/png',$5,ancestor_ids||jsonb_build_array(id) FROM hyori_items WHERE id=$3", vec![id.clone().into(), owner.id.clone().into(), parent.into(), name.into(), format!("{}/objects/{id}", owner.id).into()])).await.unwrap();
    id
}

#[tokio::test]
#[ignore = "real HTTP and PostgreSQL for outgoing sharing, shared listings and link unlock"]
async fn outgoing_shares_and_summaries_stay_with_the_owner() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = setup(&server, &pg.config).await;
    let owner = account(&server, &admin, "owner").await;
    let member = account(&server, &admin, "member").await;
    let root = folder(&server, &owner.cookie, None, "Root").await;
    let child = folder(&server, &owner.cookie, Some(&root), "Child").await;
    let trashed = folder(&server, &owner.cookie, None, "Trash me").await;
    let direct = share(&server, &owner, &root, &member, "editor").await;
    share(&server, &owner, &trashed, &member, "viewer").await;
    server
        .rpc("files.trash", json!({"id":trashed}), Some(&owner.cookie))
        .await
        .value();
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":root,"public":true,"role":"viewer","password":"long enough"}),
            Some(&owner.cookie),
        )
        .await;
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let expired = server
        .rpc(
            "shares.create",
            json!({"itemId":child,"public":true,"role":"viewer"}),
            Some(&owner.cookie),
        )
        .await;
    let expired = expired.value()["id"].as_str().unwrap();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_shares SET expires_at=now()-interval '1 second' WHERE id=$1",
            vec![expired.into()],
        ))
        .await
        .unwrap();

    let summary = server
        .rpc("files.list", json!({"sort":"nameAsc"}), Some(&owner.cookie))
        .await;
    assert_eq!(
        summary.value()["sharing"],
        json!({(root.clone()):{"peopleCount":1,"hasLink":true}})
    );
    assert!(
        server
            .rpc("files.list", json!({"parentId":root}), Some(&owner.cookie))
            .await
            .value()
            .get("sharing")
            .is_none()
    );
    for account in [&member, &admin] {
        assert_eq!(
            server
                .rpc("shares.outgoing", json!({}), Some(&account.cookie))
                .await
                .value(),
            &json!({"items":[],"nextCursor":null})
        );
    }
    assert!(
        server
            .rpc("files.list", json!({"view":"shared"}), Some(&member.cookie))
            .await
            .value()
            .get("sharing")
            .is_none()
    );
    server
        .rpc("shares.outgoing", json!({}), None)
        .await
        .error(401, "auth.required");

    let first = server
        .rpc("shares.outgoing", json!({"limit":1}), Some(&owner.cookie))
        .await;
    let first = first.value();
    let cursor = first["nextCursor"].as_str().unwrap();
    let row = &first["items"][0];
    assert_eq!(row["share"]["id"], expired);
    assert_eq!(row["share"]["url"], Value::Null);
    assert_eq!(row["itemName"], "Child");
    assert_eq!(row["expired"], true);
    server
        .rpc("shares.revoke", json!({"id":expired}), Some(&owner.cookie))
        .await
        .value();
    let rest = server
        .rpc(
            "shares.outgoing",
            json!({"cursor":cursor}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(rest.value()["nextCursor"], Value::Null);
    let rows = rest.value()["items"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["share"]["id"], link.value()["id"]);
    assert_eq!(rows[0]["expired"], false);
    assert_eq!(rows[1]["share"]["id"], direct);
    assert_eq!(rows[1]["share"]["recipient"]["id"], member.id);

    let locked = server
        .rpc(
            "shares.resolve",
            json!({"token":token}),
            Some(&member.cookie),
        )
        .await;
    assert_eq!(locked.value()["requiresPassword"], true);
    assert!(locked.value().get("sharedByName").is_none());
    let unlocked = server
        .rpc(
            "shares.unlock",
            json!({"token":token,"password":"long enough"}),
            Some(&member.cookie),
        )
        .await;
    let unlocked_value = unlocked.value();
    assert_eq!(unlocked_value["sharedByName"], "owner");
    assert_eq!(unlocked_value["share"]["role"], "viewer");
    assert_eq!(unlocked_value["item"]["access"]["role"], "editor");
    assert!(!unlocked_value.to_string().contains("owner@example.test"));
    server
        .rpc("shares.outgoing", json!({}), Some(&unlocked.credential()))
        .await
        .error(401, "auth.required");
}

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL; metadata only, no RustFS"]
async fn directory_search_and_account_share_role_changes() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = setup(&server, &pg.config).await;
    let owner = account(&server, &admin, "owner").await;
    let member = account(&server, &admin, "member").await;
    let root = folder(&server, &owner.cookie, None, "Shared folder").await;

    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET name='Élodie Martin' WHERE id=$1",
            vec![member.id.clone().into()],
        ))
        .await
        .unwrap();
    let identity = json!({"id":member.id,"name":"Élodie Martin","email":"member@example.test"});
    for query in ["  mArTiN ", "EMBER@EX", " Él "] {
        let reply = server
            .rpc("users.search", json!({"query":query}), Some(&owner.cookie))
            .await;
        assert_eq!(reply.value(), &json!({"items":[identity]}));
    }
    for query in ["OWNER", "%", "mem_er"] {
        let reply = server
            .rpc("users.search", json!({"query":query}), Some(&owner.cookie))
            .await;
        assert_eq!(reply.value(), &json!({"items":[]}));
    }
    for query in [" \t ".to_owned(), "é".repeat(101)] {
        server
            .rpc("users.search", json!({"query":query}), Some(&owner.cookie))
            .await
            .error(400, "input.invalid");
    }
    server
        .rpc("users.search", json!({"query":"member"}), None)
        .await
        .error(401, "auth.required");
    server.state.db.execute_unprepared("INSERT INTO hyori_users (id,name,email,role,quota_bytes) SELECT 'fixture-'||n,'Cap fixture '||n,'fixture-'||n||'@example.test','user',0 FROM generate_series(1,11) n").await.unwrap();
    let capped = server
        .rpc(
            "users.search",
            json!({"query":"cap fixture"}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(capped.value()["items"].as_array().unwrap().len(), 10);

    let account_share = share(&server, &owner, &root, &member, "viewer").await;
    let public_share = server
        .rpc(
            "shares.create",
            json!({"itemId":root,"public":true,"role":"viewer"}),
            Some(&owner.cookie),
        )
        .await;
    let public_id = public_share.value()["id"].as_str().unwrap();
    assert_eq!(public_share.value().get("recipient"), Some(&Value::Null));
    let listed = server
        .rpc("shares.list", json!({"itemId":root}), Some(&owner.cookie))
        .await;
    let listed = listed.value()["items"].as_array().unwrap();
    assert_eq!(listed.len(), 2);
    for item in listed {
        if item["id"] == account_share {
            assert_eq!(item["recipient"], identity);
        } else {
            assert_eq!(item["id"], public_id);
            assert_eq!(item.get("recipient"), Some(&Value::Null));
        }
    }

    let promote = json!({"id":account_share,"role":"contributor"});
    for caller in [&member.cookie, &admin.cookie] {
        server
            .rpc("shares.update", promote.clone(), Some(caller))
            .await
            .error(403, "access.denied");
    }
    for id in [public_id, "missing-share"] {
        server
            .rpc(
                "shares.update",
                json!({"id":id,"role":"editor"}),
                Some(&owner.cookie),
            )
            .await
            .error(404, "resource.notFound");
    }
    let updated = server
        .rpc("shares.update", promote, Some(&owner.cookie))
        .await;
    assert_eq!(updated.value()["id"], account_share);
    assert_eq!(updated.value()["recipient"], identity);
    assert_eq!(updated.value()["role"], "contributor");
    folder(
        &server,
        &member.cookie,
        Some(&root),
        "Allowed after promotion",
    )
    .await;
    let downgrade = json!({"id":account_share,"role":"viewer"});
    server
        .rpc("shares.update", downgrade.clone(), Some(&owner.cookie))
        .await
        .value();
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":root,"name":"Denied after downgrade"}),
            Some(&member.cookie),
        )
        .await
        .error(403, "access.denied");

    // Keep the share row visible while simulating the account deletion transition.
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET status='deleting' WHERE id=$1",
            vec![member.id.clone().into()],
        ))
        .await
        .unwrap();
    let listed = server
        .rpc("shares.list", json!({"itemId":root}), Some(&owner.cookie))
        .await;
    let former = listed.value()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == account_share)
        .unwrap();
    assert_eq!(former["recipientId"], member.id);
    assert_eq!(former.get("recipient"), Some(&Value::Null));
    let inactive = server
        .rpc(
            "users.search",
            json!({"query":"Martin"}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(inactive.value(), &json!({"items":[]}));
    server
        .rpc(
            "users.search",
            json!({"query":"admin"}),
            Some(&member.cookie),
        )
        .await
        .error(401, "auth.required");

    server
        .rpc(
            "shares.revoke",
            json!({"id":account_share}),
            Some(&owner.cookie),
        )
        .await
        .value();
    server
        .rpc("shares.update", downgrade, Some(&owner.cookie))
        .await
        .error(404, "resource.notFound");

    // Start one below the budget and spend the last search, then retry in a different session.
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_rate_limits SET attempts=239 WHERE key_digest=$1",
            vec![digest(&format!("users-search:{}", owner.id)).into()],
        ))
        .await
        .unwrap();
    let query = json!({"query":"admin"});
    server
        .rpc("users.search", query.clone(), Some(&owner.cookie))
        .await
        .value();
    let other_session = server
        .rpc(
            "auth.login",
            json!({"email":"owner@example.test","password":"correct horse battery staple"}),
            None,
        )
        .await;
    other_session.value();
    server
        .rpc(
            "users.search",
            query.clone(),
            Some(&other_session.credential()),
        )
        .await
        .error(429, "auth.rateLimited");
    server
        .rpc("users.search", query, Some(&admin.cookie))
        .await
        .value();
}

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL; metadata only, no RustFS"]
async fn files_shares_postgres_http_parity() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = setup(&server, &pg.config).await;
    let owner = account(&server, &admin, "owner").await;
    let viewer = account(&server, &admin, "viewer").await;
    let editor = account(&server, &admin, "editor").await;
    let contributor = account(&server, &admin, "contributor").await;
    server
        .rpc("files.list", json!({}), None)
        .await
        .error(401, "auth.required");
    let root = folder(&server, &owner.cookie, None, "  Cafe\u{301}  ").await;
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Café"}),
            Some(&owner.cookie),
        )
        .await
        .error(409, "resource.conflict");
    for bad in ["..", "x/y", "x\\y", "\u{1}bad", "   "] {
        server
            .rpc(
                "files.createFolder",
                json!({"parentId":null,"name":bad}),
                Some(&owner.cookie),
            )
            .await
            .error(400, "input.invalid");
    }
    let normalized_long = format!("  {}  ", "e\u{301}".repeat(255));
    folder(&server, &owner.cookie, None, &normalized_long).await;
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"x".repeat(256)}),
            Some(&owner.cookie),
        )
        .await
        .error(400, "input.invalid");
    let child = folder(&server, &owner.cookie, Some(&root), "Nested").await;
    let file = seed_file(&server, &owner, &child, "Vacation.png").await;
    let private = folder(&server, &owner.cookie, None, "Private").await;
    let private_file = seed_file(&server, &owner, &private, "Secret.png").await;
    assert!(
        names(
            &server
                .rpc("files.list", json!({"search":"png"}), Some(&admin.cookie))
                .await
        )
        .is_empty()
    );
    server
        .rpc("files.list", json!({"parentId":root}), Some(&admin.cookie))
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "files.download",
            json!({"id":private_file}),
            Some(&admin.cookie),
        )
        .await
        .error(403, "access.denied");
    let inherited = share(&server, &owner, &root, &viewer, "contributor").await;
    share(&server, &owner, &file, &viewer, "editor").await;
    share(&server, &owner, &root, &contributor, "contributor").await;
    share(&server, &owner, &file, &editor, "editor").await;
    server
        .rpc(
            "shares.create",
            json!({"itemId":file,"recipientId":viewer.id,"public":false,"role":"viewer"}),
            Some(&owner.cookie),
        )
        .await
        .error(409, "resource.conflict");
    server.rpc("shares.create", json!({"itemId":file,"recipientId":"unverified@example.test","public":false,"role":"viewer"}), Some(&owner.cookie)).await.error(400,"input.invalid");
    let listing = server
        .rpc(
            "files.list",
            json!({"parentId":child}),
            Some(&viewer.cookie),
        )
        .await;
    assert_eq!(listing.value()["items"][0]["access"]["role"], "editor");
    assert_eq!(names(&server.rpc("files.list", json!({"search":"PNG","type":"image","minSize":10,"maxSize":10,"after":"2000-01-01","before":"2100-01-01"}), Some(&viewer.cookie)).await), vec!["Vacation.png"]);
    assert!(
        names(
            &server
                .rpc(
                    "files.list",
                    json!({"parentId":root,"search":"png"}),
                    Some(&viewer.cookie)
                )
                .await
        )
        .is_empty()
    );
    assert!(
        names(
            &server
                .rpc(
                    "files.list",
                    json!({"search":"png","minSize":11}),
                    Some(&viewer.cookie)
                )
                .await
        )
        .is_empty()
    );
    let viewer_root = folder(&server, &viewer.cookie, None, "OwnedByViewer").await;
    share(&server, &viewer, &viewer_root, &owner, "contributor").await;
    server
        .rpc(
            "files.move",
            json!({"id":file,"parentId":viewer_root}),
            Some(&owner.cookie),
        )
        .await
        .error(403, "access.denied");
    assert!(
        !names(
            &server
                .rpc(
                    "files.list",
                    json!({"view":"shared","search":"Owned"}),
                    Some(&viewer.cookie)
                )
                .await
        )
        .contains(&"OwnedByViewer".into())
    );
    let contributed = server
        .rpc(
            "files.createFolder",
            json!({"parentId":child,"name":"Contributed"}),
            Some(&contributor.cookie),
        )
        .await;
    assert_eq!(contributed.value()["ownerId"], owner.id);
    assert_eq!(contributed.value()["access"]["isOwner"], false);
    let contributed_id = contributed.value()["id"].as_str().unwrap();
    server
        .rpc(
            "files.rename",
            json!({"id":file,"name":"blocked"}),
            Some(&contributor.cookie),
        )
        .await
        .error(403, "access.denied");
    // A direct file Editor who cannot list the parent cannot rename either: the answer would
    // reveal which names the folder holds.
    server
        .rpc(
            "files.list",
            json!({"parentId":child}),
            Some(&editor.cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "files.rename",
            json!({"id":file,"name":" Edited.png "}),
            Some(&editor.cookie),
        )
        .await
        .error(403, "access.denied");
    assert_eq!(
        server
            .rpc(
                "files.rename",
                json!({"id":file,"name":" Edited.png "}),
                Some(&owner.cookie)
            )
            .await
            .value()["name"],
        "Edited.png"
    );
    for cookie in [&editor.cookie, &contributor.cookie] {
        for (op, input) in [
            ("files.move", json!({"id":file,"parentId":null})),
            ("files.trash", json!({"id":file})),
            ("files.restore", json!({"id":file})),
            ("files.versions", json!({"id":file})),
            ("shares.list", json!({"itemId":file})),
            (
                "shares.create",
                json!({"itemId":file,"public":true,"role":"viewer"}),
            ),
        ] {
            server
                .rpc(op, input, Some(cookie))
                .await
                .error(403, "access.denied");
        }
    }
    server
        .rpc(
            "files.trash",
            json!({"id":contributed_id}),
            Some(&contributor.cookie),
        )
        .await
        .error(403, "access.denied");
    // Removing inherited Contributor leaves the stronger, independent direct Editor.
    server
        .rpc(
            "shares.revoke",
            json!({"id":inherited}),
            Some(&owner.cookie),
        )
        .await
        .value();
    assert_eq!(
        server
            .rpc("files.get", json!({"id":file}), Some(&viewer.cookie))
            .await
            .value()["access"]["role"],
        "editor"
    );
    // Stable opaque ID keyset pages, no duplicated or skipped items.
    let first = server
        .rpc(
            "files.list",
            json!({"parentId":child,"limit":1}),
            Some(&owner.cookie),
        )
        .await;
    let cursor = first.value()["nextCursor"].clone();
    assert!(cursor.is_string());
    let second = server
        .rpc(
            "files.list",
            json!({"parentId":child,"limit":1,"cursor":cursor}),
            Some(&owner.cookie),
        )
        .await;
    assert_ne!(
        first.value()["items"][0]["id"],
        second.value()["items"][0]["id"]
    );
    assert_eq!(second.value()["nextCursor"], Value::Null);
    server
        .rpc(
            "files.list",
            json!({"cursor":"bad cursor!"}),
            Some(&owner.cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc("files.list", json!({"limit":101}), Some(&owner.cookie))
        .await
        .error(400, "input.invalid");

    let public = server
        .rpc(
            "shares.create",
            json!({"itemId":root,"public":true,"role":"editor","password":"link password"}),
            Some(&owner.cookie),
        )
        .await;
    let public_id = public.value()["id"].as_str().unwrap();
    let token = public.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let locked = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await;
    assert_eq!(locked.value()["requiresPassword"], true);
    assert_eq!(locked.value()["item"], Value::Null);
    assert!(locked.cookie.is_none());
    assert!(!locked.body.to_string().contains("Café"));
    server
        .rpc(
            "files.list",
            json!({"parentId":root}),
            Some(&format!("hyori_grants={token}")),
        )
        .await
        .error(401, "auth.required");
    server
        .rpc(
            "shares.unlock",
            json!({"token":token,"password":"wrong"}),
            None,
        )
        .await
        .error(403, "access.denied");
    let unlocked = server
        .rpc(
            "shares.unlock",
            json!({"token":token,"password":"link password"}),
            None,
        )
        .await;
    assert_eq!(unlocked.value()["requiresPassword"], false);
    let grant1 = unlocked.credential();
    for attr in ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=43200"] {
        assert!(unlocked.cookie.as_ref().unwrap().contains(attr));
    }
    assert!(!unlocked.cookie.as_ref().unwrap().contains("Domain="));
    let anonymous = server
        .rpc(
            "files.createFolder",
            json!({"parentId":root,"name":"Anonymous"}),
            Some(&grant1),
        )
        .await;
    assert_eq!(anonymous.value()["ownerId"], owner.id);
    let anon_id = anonymous.value()["id"].as_str().unwrap();
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT uploaded_by FROM hyori_items WHERE id=$1",
            vec![anon_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<Option<String>>("", "uploaded_by").unwrap(),
        None
    );
    for (op, input) in [
        ("files.trash", json!({"id":file})),
        ("files.move", json!({"id":file,"parentId":null})),
        ("files.versions", json!({"id":file})),
        (
            "shares.create",
            json!({"itemId":file,"public":true,"role":"viewer"}),
        ),
    ] {
        server
            .rpc(op, input, Some(&grant1))
            .await
            .error(403, "access.denied");
    }
    server
        .rpc(
            "files.rename",
            json!({"id":file,"name":"Public edit.png"}),
            Some(&grant1),
        )
        .await
        .value();
    let other_link = server
        .rpc(
            "shares.create",
            json!({"itemId":private,"public":true,"role":"viewer"}),
            Some(&owner.cookie),
        )
        .await;
    let other_token = other_link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let other = server
        .rpc(
            "shares.resolve",
            json!({"token":other_token}),
            Some(&grant1),
        )
        .await;
    other.value();
    let mut jar = CookieJar::default();
    jar.apply(&unlocked);
    jar.apply(&other);
    let grants = jar.header();
    assert_eq!(jar.len(), 2);
    let reopened = server
        .rpc(
            "shares.resolve",
            json!({"token":other_token}),
            Some(&grants),
        )
        .await;
    reopened.value();
    jar.apply(&reopened);
    let grants = jar.header();
    assert_eq!(jar.len(), 2);
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":private,"name":"blocked"}),
            Some(&grants),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc("files.list", json!({"parentId":root}), Some(&grants))
        .await
        .value();
    server
        .rpc("files.list", json!({"parentId":private}), Some(&grants))
        .await
        .value();
    server
        .rpc(
            "files.rename",
            json!({"id":private_file,"name":"blocked"}),
            Some(&grants),
        )
        .await
        .error(403, "access.denied");
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT token_digest,password_hash FROM hyori_shares WHERE id=$1",
            vec![public_id.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row.try_get::<String>("", "token_digest").unwrap(),
        digest(token)
    );
    assert_ne!(
        row.try_get::<String>("", "password_hash").unwrap(),
        "link password"
    );
    // The visitor's credential is a capability living at most 12 hours; nothing was stored.
    let (issued, expires) = link_capability::times(grant1.split_once('=').unwrap().1);
    assert!((1..=43_200_000).contains(&(expires - issued)));
    let stored = server
        .state
        .db
        .query_one_raw(sql("SELECT count(*) AS n FROM hyori_grants", vec![]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.try_get::<i64>("", "n").unwrap(), 0);
    server
        .rpc(
            "shares.revoke",
            json!({"id":public_id}),
            Some(&owner.cookie),
        )
        .await
        .value();
    server
        .rpc("files.list", json!({"parentId":root}), Some(&grants))
        .await
        .error(403, "access.denied");
    server
        .rpc("shares.resolve", json!({"token":token}), Some(&grants))
        .await
        .error(403, "access.denied");
    server
        .rpc("files.list", json!({"parentId":private}), Some(&grants))
        .await
        .value();
    // The same browser after its capability for the other link has expired.
    let other_id = other_link.value()["id"].as_str().unwrap();
    let expired = link_capability::expired(&server, other_id).await;
    let grants = grants
        .split("; ")
        .map(|cookie| match cookie.split_once('=') {
            Some((name, _)) if name == format!("hyori_grant_{other_id}") => {
                format!("{name}={expired}")
            }
            _ => cookie.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("; ");
    server
        .rpc("files.list", json!({"parentId":private}), Some(&grants))
        .await
        .error(401, "auth.required");
    let renewed = server
        .rpc("shares.resolve", json!({"token":other_token}), None)
        .await;
    renewed.value();
    let renewed_cookie = renewed.credential();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_shares SET expires_at=now()-interval '1 second' WHERE id=$1",
            vec![other_link.value()["id"].as_str().unwrap().into()],
        ))
        .await
        .unwrap();
    server
        .rpc(
            "files.list",
            json!({"parentId":private}),
            Some(&renewed_cookie),
        )
        .await
        .error(401, "auth.required");
    server
        .rpc("shares.resolve", json!({"token":other_token}), None)
        .await
        .error(403, "access.denied");
    // Current owner availability applies to direct and inherited reads, not just link resolution.
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET status='deleting' WHERE id=$1",
            vec![owner.id.into()],
        ))
        .await
        .unwrap();
    assert!(
        names(
            &server
                .rpc(
                    "files.list",
                    json!({"view":"shared","search":"png"}),
                    Some(&editor.cookie)
                )
                .await
        )
        .is_empty()
    );
    server
        .rpc("files.download", json!({"id":file}), Some(&editor.cookie))
        .await
        .error(404, "resource.notFound");
}

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL; metadata only, no RustFS"]
async fn trash_versions_hierarchy_and_name_races() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = setup(&server, &pg.config).await;
    let owner = account(&server, &admin, "owner").await;
    let root = folder(&server, &owner.cookie, None, "Root").await;
    let independently_trashed = folder(&server, &owner.cookie, Some(&root), "Earlier").await;
    server
        .rpc(
            "files.trash",
            json!({"id":independently_trashed}),
            Some(&owner.cookie),
        )
        .await
        .value();
    let live = folder(&server, &owner.cookie, Some(&root), "Live").await;
    let file = seed_file(&server, &owner, &live, "Versioned.png").await;
    server
        .rpc("files.trash", json!({"id":root}), Some(&owner.cookie))
        .await
        .value();
    assert_eq!(
        names(
            &server
                .rpc("files.list", json!({"view":"trash"}), Some(&owner.cookie))
                .await
        )
        .len(),
        2
    );
    server
        .rpc("files.restore", json!({"id":live}), Some(&owner.cookie))
        .await
        .error(409, "resource.conflict");
    server
        .rpc(
            "files.restore",
            json!({"id":independently_trashed}),
            Some(&owner.cookie),
        )
        .await
        .error(404, "resource.notFound");
    let conflict = folder(&server, &owner.cookie, None, "Root").await;
    server
        .rpc("files.restore", json!({"id":root}), Some(&owner.cookie))
        .await
        .error(409, "resource.conflict");
    server
        .rpc(
            "files.rename",
            json!({"id":conflict,"name":"Other"}),
            Some(&owner.cookie),
        )
        .await
        .value();
    server
        .rpc("files.restore", json!({"id":root}), Some(&owner.cookie))
        .await
        .value();
    assert_eq!(
        names(
            &server
                .rpc("files.list", json!({"parentId":root}), Some(&owner.cookie))
                .await
        ),
        vec!["Live"]
    );
    assert_eq!(
        names(
            &server
                .rpc("files.list", json!({"view":"trash"}), Some(&owner.cookie))
                .await
        ),
        vec!["Earlier"]
    );
    server
        .rpc(
            "files.restore",
            json!({"id":independently_trashed}),
            Some(&owner.cookie),
        )
        .await
        .value();
    let moved = server
        .rpc(
            "files.move",
            json!({"id":root,"parentId":conflict}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(moved.value()["parentId"], conflict);
    let moved_child = server
        .rpc("files.list", json!({"parentId":live}), Some(&owner.cookie))
        .await;
    assert_eq!(
        moved_child.value()["breadcrumbs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["Other", "Root", "Live"]
    );
    server
        .rpc(
            "files.move",
            json!({"id":root,"parentId":null}),
            Some(&owner.cookie),
        )
        .await
        .value();
    // Name uniqueness remains atomic across separate app instances, including NULL-root parents.
    let second = TestServer::start(pg.config.clone()).await;
    let (a, b) = tokio::join!(
        server.rpc(
            "files.createFolder",
            json!({"parentId":null,"name":" Racing "}),
            Some(&owner.cookie)
        ),
        second.rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Racing"}),
            Some(&owner.cookie)
        )
    );
    let mut statuses = vec![a.status, b.status];
    statuses.sort();
    assert_eq!(statuses, vec![200, 409]);
    // Existing immutable bytes are fixtures, not fake RustFS content.
    server.state.db.execute_raw(sql("INSERT INTO hyori_versions(id,file_id,owner_id,object_key,size,mime_type) VALUES ('oldversion',$1,$2,'fixture/old-object',7,'image/jpeg');",vec![file.clone().into(),owner.id.clone().into()])).await.unwrap();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET used_bytes=17 WHERE id=$1",
            vec![owner.id.clone().into()],
        ))
        .await
        .unwrap();
    let restored = server
        .rpc(
            "files.restoreVersion",
            json!({"id":file,"versionId":"oldversion"}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(restored.value()["size"], 7);
    assert_eq!(restored.value()["mimeType"], "image/jpeg");
    let history = server
        .rpc("files.versions", json!({"id":file}), Some(&owner.cookie))
        .await;
    assert_eq!(history.value()["items"].as_array().unwrap().len(), 2);
    let previous = history.value()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] != "oldversion")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let download = server
        .rpc(
            "files.download",
            json!({"id":file,"versionId":previous}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(
        download.value()["url"],
        format!("/api/storage/files/{file}?version={previous}")
    );
    assert_eq!(download.value()["size"], 10);
    assert!(!download.body.to_string().contains("object_key"));
    assert_eq!(
        server
            .rpc(
                "files.restoreVersion",
                json!({"id":file,"versionId":previous}),
                Some(&owner.cookie)
            )
            .await
            .value()["size"],
        10
    );
    let row = server
        .state
        .db
        .query_one_raw(sql(
            "SELECT used_bytes FROM hyori_users WHERE id=$1",
            vec![owner.id.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.try_get::<i64>("", "used_bytes").unwrap(), 17);
    let history_count = server
        .rpc("files.versions", json!({"id":file}), Some(&owner.cookie))
        .await
        .value()["items"]
        .as_array()
        .unwrap()
        .len();
    server
        .rpc(
            "files.restoreVersion",
            json!({"id":file,"versionId":previous}),
            Some(&owner.cookie),
        )
        .await
        .value();
    assert_eq!(
        server
            .rpc("files.versions", json!({"id":file}), Some(&owner.cookie))
            .await
            .value()["items"]
            .as_array()
            .unwrap()
            .len(),
        history_count
    );
    let stranger = account(&server, &admin, "stranger").await;
    share(&server, &owner, &file, &stranger, "editor").await;
    server
        .rpc(
            "files.download",
            json!({"id":file,"versionId":"oldversion"}),
            Some(&stranger.cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "files.restoreVersion",
            json!({"id":file,"versionId":"oldversion"}),
            Some(&stranger.cookie),
        )
        .await
        .error(403, "access.denied");
    let different = seed_file(&server, &owner, &root, "Different.png").await;
    server
        .rpc(
            "files.restoreVersion",
            json!({"id":different,"versionId":"oldversion"}),
            Some(&owner.cookie),
        )
        .await
        .error(404, "resource.notFound");
    server.state.db.execute_raw(sql("INSERT INTO hyori_versions(id,file_id,owner_id,object_key,size,mime_type) SELECT 'page-'||lpad(n::text,3,'0'),$1,$2,'fixture/history/'||n,1,'image/png' FROM generate_series(1,105) n",vec![file.clone().into(),owner.id.clone().into()])).await.unwrap();
    let page = server
        .rpc("files.versions", json!({"id":file}), Some(&owner.cookie))
        .await;
    assert_eq!(page.value()["items"].as_array().unwrap().len(), 100);
    let next = server
        .rpc(
            "files.versions",
            json!({"id":file,"cursor":page.value()["nextCursor"]}),
            Some(&owner.cookie),
        )
        .await;
    assert_eq!(next.value()["items"].as_array().unwrap().len(), 8);
    assert_eq!(next.value()["nextCursor"], Value::Null);
    // 64 levels includes root; mutation failure leaves the whole subtree unchanged.
    let mut deepest = folder(&server, &owner.cookie, None, "Deep").await;
    let deep_root = deepest.clone();
    for level in 1..64 {
        deepest = folder(
            &server,
            &owner.cookie,
            Some(&deepest),
            &format!("level-{level}"),
        )
        .await;
    }
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":deepest,"name":"TooDeep"}),
            Some(&owner.cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "files.move",
            json!({"id":deep_root,"parentId":root}),
            Some(&owner.cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "files.move",
            json!({"id":root,"parentId":live}),
            Some(&owner.cookie),
        )
        .await
        .error(400, "input.invalid");
    let huge = folder(&server, &owner.cookie, None, "Huge").await;
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,mime_type,ancestor_ids) SELECT 'huge-'||n,$1,$2,'entry-'||n,'folder','inode/directory',jsonb_build_array($2::text) FROM generate_series(1,1001) n",vec![owner.id.clone().into(),huge.clone().into()])).await.unwrap();
    // No descendant cap: each operation rewrites the whole subtree in one set-based statement.
    let subtree = |state: &'static str| {
        format!(
            "SELECT count(*) AS count FROM hyori_items WHERE ancestor_ids @> jsonb_build_array($1::text) AND {state}"
        )
    };
    let count = |query: String, values: Vec<sea_orm::Value>| {
        let db = &server.state.db;
        async move {
            db.query_one_raw(sql(&query, values))
                .await
                .unwrap()
                .unwrap()
                .try_get::<i64>("", "count")
                .unwrap()
        }
    };
    server
        .rpc("files.trash", json!({"id":huge}), Some(&owner.cookie))
        .await
        .value();
    assert_eq!(
        count(subtree("trash_root=$1"), vec![huge.clone().into()]).await,
        1001
    );
    server
        .rpc("files.restore", json!({"id":huge}), Some(&owner.cookie))
        .await
        .value();
    assert_eq!(
        count(subtree("trashed_at IS NOT NULL"), vec![huge.clone().into()]).await,
        0
    );
    server
        .rpc(
            "files.move",
            json!({"id":huge,"parentId":root}),
            Some(&owner.cookie),
        )
        .await
        .value();
    assert_eq!(
        count(
            "SELECT count(*) AS count FROM hyori_items WHERE ancestor_ids @> jsonb_build_array($1::text,$2::text)".into(),
            vec![root.clone().into(), huge.clone().into()]
        )
        .await,
        1001
    );
}

#[tokio::test]
#[ignore = "real concurrent HTTP/PostgreSQL snapshot race; metadata only, no RustFS"]
async fn snapshot_does_not_mix_revoked_grants_with_moved_private_metadata() {
    let pg = Postgres::start().await;
    let first = TestServer::start(pg.config.clone()).await;
    let second = TestServer::start(pg.config.clone()).await;
    let admin = setup(&first, &pg.config).await;
    let owner = account(&first, &admin, "owner").await;
    let viewer = account(&first, &admin, "viewer").await;
    let shared = folder(&first, &owner.cookie, None, "Shared").await;
    let private = folder(&first, &owner.cookie, None, "Private").await;
    let file = seed_file(&first, &owner, &shared, "Public-before-race.png").await;
    let share_id = share(&first, &owner, &shared, &viewer, "viewer").await;
    // Hold only a test table lock so the HTTP reader first resolves its grants, then blocks on
    // item metadata. The lock holder commits revoke+move+private rename before that read resumes.
    let tx = first.state.db.begin().await.unwrap();
    tx.execute_unprepared("LOCK TABLE hyori_items IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let request = second.rpc(
        "files.list",
        json!({"view":"shared","search":"png"}),
        Some(&viewer.cookie),
    );
    let change = async {
        let mut waiting = false;
        for _ in 0..100 {
            // Grant resolution never reads items, so a lock wait on them is the metadata query.
            let row=first.state.db.query_one_raw(sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM hyori_items i%') AS waiting",vec![])).await.unwrap().unwrap();
            if row.try_get::<bool>("", "waiting").unwrap() {
                waiting = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            waiting,
            "HTTP read reached the metadata query after grant resolution"
        );
        tx.execute_raw(sql(
            "UPDATE hyori_shares SET revoked_at=now() WHERE id=$1",
            vec![share_id.into()],
        ))
        .await
        .unwrap();
        tx.execute_raw(sql("UPDATE hyori_items SET parent_id=$1,ancestor_ids=jsonb_build_array($1::text),name='Private-after-race.png',revision=revision+1 WHERE id=$2",vec![private.into(),file.clone().into()])).await.unwrap();
        tx.commit().await.unwrap();
    };
    let (reply, ()) = tokio::join!(request, change);
    assert_eq!(names(&reply), vec!["Public-before-race.png"]);
    assert!(!reply.body.to_string().contains("Private-after-race"));
    assert!(
        names(
            &first
                .rpc(
                    "files.list",
                    json!({"view":"shared","search":"png"}),
                    Some(&viewer.cookie)
                )
                .await
        )
        .is_empty()
    );
    second
        .rpc("files.download", json!({"id":file}), Some(&viewer.cookie))
        .await
        .error(403, "access.denied");
    // Also exercise production mutation handlers from the other app instance concurrently.
    let link = first
        .rpc(
            "shares.create",
            json!({"itemId":shared,"public":true,"role":"viewer"}),
            Some(&owner.cookie),
        )
        .await;
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let opened = second
        .rpc("shares.resolve", json!({"token":token}), None)
        .await;
    opened.value();
    let grant = opened.credential();
    let (revoke, read) = tokio::join!(
        first.rpc(
            "shares.revoke",
            json!({"id":link.value()["id"]}),
            Some(&owner.cookie)
        ),
        second.rpc("files.list", json!({"parentId":shared}), Some(&grant))
    );
    revoke.value();
    assert!(matches!(read.status, 200 | 401));
    second
        .rpc("files.list", json!({"parentId":shared}), Some(&grant))
        .await
        .error(401, "auth.required");
    drop(first);
    drop(second);
    pg.stop();
}
