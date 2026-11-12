use super::{account, folder, names, seed_file, setup, share};
use crate::support::{Postgres, TestServer};
use hyori_server::db::sql;
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::{Value, json};

#[tokio::test]
#[ignore = "real HTTP/PostgreSQL parent listing, filters, projection and current authority"]
async fn parent_listing_preserves_filters_lookahead_breadcrumbs_and_roles() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = setup(&server, &pg.config).await;
    let owner = account(&server, &admin, "owner").await;
    let recipient = account(&server, &admin, "recipient").await;
    let hidden = folder(&server, &owner.cookie, None, "Hidden").await;
    let parent = folder(&server, &owner.cookie, Some(&hidden), "Shared").await;
    let inherited = share(&server, &owner, &parent, &recipient, "contributor").await;
    // Synthetic metadata only; no object bytes or upload acceptance is claimed here.
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,ancestor_ids,updated_at)
         SELECT 'listing-child-'||lpad(n::text,4,'0'),$1,$2,'REPORT-'||n||'.png','file',10,'image/png',
           (SELECT ancestor_ids||jsonb_build_array(id) FROM hyori_items WHERE id=$2),'2020-01-02T03:04:05Z'
         FROM generate_series(1,101) n",
        vec![owner.id.clone().into(),parent.clone().into()],
    )).await.unwrap();
    share(&server, &owner, "listing-child-0001", &recipient, "editor").await;
    let nested = folder(&server, &owner.cookie, Some(&parent), "Nested").await;
    seed_file(&server, &owner, &nested, "REPORT-descendant.png").await;
    let filter = json!({"parentId":parent,"view":"shared","search":"REPORT","type":"image","after":"2020-01-02T03:04:05Z","before":"2020-01-02T03:04:05Z","minSize":10,"maxSize":10});
    let first = server
        .rpc("files.list", filter.clone(), Some(&recipient.cookie))
        .await;
    let items = first.value()["items"].as_array().unwrap();
    assert_eq!(items.len(), 100);
    assert_eq!(first.value()["nextCursor"], "listing-child-0100");
    assert_eq!(items[0]["access"]["role"], "editor");
    assert_eq!(items[1]["access"]["role"], "contributor");
    assert!(
        items
            .iter()
            .all(|item| item["access"]["canDelete"] == false)
    );
    assert_eq!(
        first.value()["breadcrumbs"],
        json!([{"id":parent,"name":"Shared"}])
    );
    assert_eq!(first.value()["folder"]["access"]["canUpload"], true);
    assert!(!first.body.to_string().contains("Hidden"));
    let mut next_filter = filter.clone();
    next_filter["cursor"] = first.value()["nextCursor"].clone();
    let next = server
        .rpc("files.list", next_filter, Some(&recipient.cookie))
        .await;
    assert_eq!(names(&next), vec!["REPORT-101.png"]);
    assert_eq!(next.value()["nextCursor"], Value::Null);
    // The shared view excludes owned items even inside an explicitly supplied owned folder.
    assert!(
        names(
            &server
                .rpc("files.list", filter.clone(), Some(&owner.cookie))
                .await
        )
        .is_empty()
    );
    for kind in ["file", "image", "image/png"] {
        let mut exact = filter.clone();
        exact["type"] = json!(kind);
        exact["limit"] = json!(1);
        assert_eq!(
            server
                .rpc("files.list", exact, Some(&recipient.cookie))
                .await
                .value()["items"][0]["id"],
            "listing-child-0001"
        );
    }
    let literal = seed_file(&server, &owner, &parent, "quote' OR true;--.png").await;
    let result = server
        .rpc(
            "files.list",
            json!({"parentId":parent,"search":"' OR true;--"}),
            Some(&recipient.cookie),
        )
        .await;
    assert_eq!(result.value()["items"].as_array().unwrap().len(), 1);
    assert_eq!(result.value()["items"][0]["id"], literal);
    let zero = server
        .rpc(
            "files.list",
            json!({"parentId":parent,"type":"folder","minSize":0,"maxSize":0}),
            Some(&recipient.cookie),
        )
        .await;
    assert_eq!(names(&zero), vec!["Nested"]);
    server
        .rpc(
            "files.list",
            json!({"parentId":"listing-child-0001"}),
            Some(&recipient.cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "files.list",
            json!({"parentId":parent}),
            Some(&admin.cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "shares.revoke",
            json!({"id":inherited}),
            Some(&owner.cookie),
        )
        .await
        .value();
    // Direct child access must not bypass the supplied-parent precondition.
    server
        .rpc(
            "files.list",
            json!({"parentId":parent}),
            Some(&recipient.cookie),
        )
        .await
        .error(403, "access.denied");
    server
        .rpc(
            "files.get",
            json!({"id":"listing-child-0001"}),
            Some(&recipient.cookie),
        )
        .await
        .value();
}

#[tokio::test]
#[ignore = "real HTTP/PostgreSQL shared roots across 1201 grants and mixed public authority"]
async fn shared_root_listing_deduplicates_before_paging_and_revalidates_authority() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = setup(&server, &pg.config).await;
    let owner = account(&server, &admin, "owner").await;
    let recipient = account(&server, &admin, "recipient").await;
    let issuer = account(&server, &admin, "issuer").await;
    let parent = folder(&server, &owner.cookie, None, "Shared folder").await;
    share(&server, &owner, &parent, &recipient, "viewer").await;
    let descendant = seed_file(&server, &owner, &parent, "Inherited-only.png").await;
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_items(id,owner_id,name,kind,size,mime_type,updated_at)
         SELECT 'listing-root-'||lpad(n::text,4,'0'),$1,'Root-'||n||'.png','file',10,'image/png','2020-01-02T03:04:05Z'
         FROM generate_series(1,1201) n", vec![owner.id.clone().into()],
    )).await.unwrap();
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_shares(id,item_id,issuer_id,recipient_id,public,role)
         SELECT 'listing-share-'||lpad(n::text,4,'0'),'listing-root-'||lpad(n::text,4,'0'),$1,$2,false,'viewer'
         FROM generate_series(1,1201) n", vec![owner.id.clone().into(),recipient.id.clone().into()],
    )).await.unwrap();
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":"listing-root-0001","public":true,"role":"editor"}),
            Some(&owner.cookie),
        )
        .await;
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let grant = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await;
    grant.value();
    let public_cookie = grant.credential();
    let mixed = format!("{}; {}", recipient.cookie, public_cookie);
    let mut cursor = Value::Null;
    let mut ids = vec![];
    for page in 0..13 {
        let reply = server.rpc("files.list", json!({"view":"shared","type":"image","after":"2020-01-02T03:04:05Z","before":"2020-01-02T03:04:05Z","minSize":10,"maxSize":10,"cursor":cursor}), Some(&mixed)).await;
        let items = reply.value()["items"].as_array().unwrap();
        assert_eq!(items.len(), if page == 12 { 1 } else { 100 });
        if page == 0 {
            assert_eq!(items[0]["access"]["role"], "editor");
            assert_eq!(items[0]["access"]["canDelete"], false);
        }
        ids.extend(
            items
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_owned()),
        );
        cursor = reply.value()["nextCursor"].clone();
        assert_eq!(cursor.is_null(), page == 12);
    }
    assert_eq!(
        ids,
        (1..=1201)
            .map(|n| format!("listing-root-{n:04}"))
            .collect::<Vec<_>>()
    );
    let anonymous = server
        .rpc("files.list", json!({"view":"shared"}), Some(&public_cookie))
        .await;
    assert_eq!(anonymous.value()["items"].as_array().unwrap().len(), 1);
    assert_eq!(anonymous.value()["items"][0]["id"], "listing-root-0001");
    let owner_with_grant = format!("{}; {}", owner.cookie, public_cookie);
    assert!(
        names(
            &server
                .rpc(
                    "files.list",
                    json!({"view":"shared"}),
                    Some(&owner_with_grant)
                )
                .await
        )
        .is_empty()
    );
    // Ordinary roots and library-wide searches retain baseline semantics.
    assert!(
        !names(
            &server
                .rpc("files.list", json!({}), Some(&recipient.cookie))
                .await
        )
        .is_empty()
    );
    let search = server
        .rpc(
            "files.list",
            json!({"view":"shared","search":"Inherited-only"}),
            Some(&recipient.cookie),
        )
        .await;
    assert_eq!(search.value()["items"][0]["id"], descendant);
    // A direct grant overlapping inherited access must not duplicate a search row or its cursor.
    let overlap = share(&server, &owner, &descendant, &recipient, "editor").await;
    let overlapping = server
        .rpc(
            "files.list",
            json!({"view":"shared","search":"Inherited-only","limit":1}),
            Some(&recipient.cookie),
        )
        .await;
    assert_eq!(overlapping.value()["items"].as_array().unwrap().len(), 1);
    assert_eq!(overlapping.value()["items"][0]["id"], descendant);
    assert_eq!(overlapping.value()["items"][0]["access"]["role"], "editor");
    assert_eq!(overlapping.value()["nextCursor"], Value::Null);
    server
        .rpc("shares.revoke", json!({"id":overlap}), Some(&owner.cookie))
        .await
        .value();
    // Expiry, revocation, trash, inactive issuer, and inactive owner each exclude direct roots.
    server.state.db.execute_raw(sql("UPDATE hyori_shares SET expires_at=now()-interval '1 second' WHERE id='listing-share-1198'", vec![])).await.unwrap();
    server
        .rpc(
            "shares.revoke",
            json!({"id":"listing-share-1199"}),
            Some(&owner.cookie),
        )
        .await
        .value();
    server
        .rpc(
            "files.trash",
            json!({"id":"listing-root-1200"}),
            Some(&owner.cookie),
        )
        .await
        .value();
    // Fixture-only distinct issuer tests the SQL guard independently of owner status.
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_shares SET issuer_id=$1 WHERE id='listing-share-1201'",
            vec![issuer.id.clone().into()],
        ))
        .await
        .unwrap();
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET status='deleting' WHERE id=$1",
            vec![issuer.id.clone().into()],
        ))
        .await
        .unwrap();
    assert!(
        names(
            &server
                .rpc(
                    "files.list",
                    json!({"view":"shared","type":"image","cursor":"listing-root-1197"}),
                    Some(&mixed)
                )
                .await
        )
        .is_empty()
    );
    server
        .rpc(
            "shares.revoke",
            json!({"id":link.value()["id"]}),
            Some(&owner.cookie),
        )
        .await
        .value();
    server
        .rpc("files.list", json!({"view":"shared"}), Some(&public_cookie))
        .await
        .error(401, "auth.required");
    let remaining = server
        .rpc(
            "files.list",
            json!({"view":"shared","limit":1,"type":"image"}),
            Some(&mixed),
        )
        .await;
    assert_eq!(remaining.value()["items"][0]["access"]["role"], "viewer");
    server
        .state
        .db
        .execute_raw(sql(
            "UPDATE hyori_users SET status='deleting' WHERE id=$1",
            vec![owner.id.clone().into()],
        ))
        .await
        .unwrap();
    assert!(
        names(
            &server
                .rpc("files.list", json!({"view":"shared"}), Some(&mixed))
                .await
        )
        .is_empty()
    );
}

#[tokio::test]
#[ignore = "real HTTP/PostgreSQL owner-only trash groups and preserved parent preconditions"]
async fn trash_listing_keeps_owner_groups_filters_and_parent_preconditions() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let admin = setup(&server, &pg.config).await;
    let owner = account(&server, &admin, "owner").await;
    let recipient = account(&server, &admin, "recipient").await;
    let live = folder(&server, &owner.cookie, None, "Live parent").await;
    let root = folder(&server, &owner.cookie, None, "Trash root").await;
    let early = folder(&server, &owner.cookie, Some(&root), "Trash early").await;
    let child = folder(&server, &owner.cookie, Some(&root), "Trash child").await;
    share(&server, &owner, &root, &recipient, "editor").await;
    server
        .rpc("files.trash", json!({"id":early}), Some(&owner.cookie))
        .await
        .value();
    server
        .rpc("files.trash", json!({"id":root}), Some(&owner.cookie))
        .await
        .value();
    let filter = json!({"view":"trash","parentId":live,"search":"TRASH","type":"folder","minSize":0,"maxSize":0,"after":"2000-01-01","before":"2100-01-01","limit":1});
    let first = server
        .rpc("files.list", filter.clone(), Some(&owner.cookie))
        .await;
    let mut second_filter = filter;
    second_filter["cursor"] = first.value()["nextCursor"].clone();
    assert!(second_filter["cursor"].is_string());
    let second = server
        .rpc("files.list", second_filter, Some(&owner.cookie))
        .await;
    let actual = [
        first.value()["items"][0]["id"].as_str().unwrap(),
        second.value()["items"][0]["id"].as_str().unwrap(),
    ];
    let mut expected = [root.as_str(), early.as_str()];
    expected.sort();
    assert_eq!(actual, expected);
    assert!(!actual.contains(&child.as_str()));
    assert_eq!(second.value()["nextCursor"], Value::Null);
    assert_eq!(first.value()["folder"]["id"], live);
    assert_eq!(first.value()["items"][0]["access"]["isOwner"], true);
    assert!(
        names(
            &server
                .rpc(
                    "files.list",
                    json!({"view":"trash"}),
                    Some(&recipient.cookie)
                )
                .await
        )
        .is_empty()
    );
    assert!(
        names(
            &server
                .rpc("files.list", json!({"view":"trash"}), Some(&admin.cookie))
                .await
        )
        .is_empty()
    );
    server
        .rpc(
            "files.list",
            json!({"view":"trash","parentId":root}),
            Some(&owner.cookie),
        )
        .await
        .error(404, "resource.notFound");
    server
        .rpc(
            "files.list",
            json!({"view":"trash","parentId":live}),
            Some(&recipient.cookie),
        )
        .await
        .error(403, "access.denied");
    let link = server
        .rpc(
            "shares.create",
            json!({"itemId":live,"public":true,"role":"viewer"}),
            Some(&owner.cookie),
        )
        .await;
    let token = link.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let opened = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await;
    opened.value();
    server
        .rpc(
            "files.list",
            json!({"view":"trash"}),
            Some(&opened.credential()),
        )
        .await
        .error(401, "auth.required");
}

#[tokio::test]
#[ignore = "real concurrent HTTP/PostgreSQL snapshot race for the direct shared-root CTE"]
async fn shared_root_listing_does_not_mix_revoke_with_new_private_metadata() {
    let pg = Postgres::start().await;
    let first = TestServer::start(pg.config.clone()).await;
    let second = TestServer::start(pg.config.clone()).await;
    let admin = setup(&first, &pg.config).await;
    let owner = account(&first, &admin, "owner").await;
    let recipient = account(&first, &admin, "recipient").await;
    let root = folder(&first, &owner.cookie, None, "Public before race").await;
    let grant = share(&first, &owner, &root, &recipient, "viewer").await;
    let tx = first.state.db.begin().await.unwrap();
    tx.execute_unprepared("LOCK TABLE hyori_items IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let request = second.rpc(
        "files.list",
        json!({"view":"shared"}),
        Some(&recipient.cookie),
    );
    let change = async {
        let mut waiting = false;
        for _ in 0..100 {
            let row = first.state.db.query_one_raw(sql(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'WITH eligible AS MATERIALIZED%') AS waiting", vec![],
            )).await.unwrap().unwrap();
            if row.try_get::<bool>("", "waiting").unwrap() {
                waiting = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            waiting,
            "listing CTE reached metadata after identity resolution"
        );
        tx.execute_raw(sql(
            "UPDATE hyori_shares SET revoked_at=now() WHERE id=$1",
            vec![grant.into()],
        ))
        .await
        .unwrap();
        tx.execute_raw(sql(
            "UPDATE hyori_items SET name='Private after race',revision=revision+1 WHERE id=$1",
            vec![root.into()],
        ))
        .await
        .unwrap();
        tx.commit().await.unwrap();
    };
    let (reply, ()) = tokio::join!(request, change);
    assert_eq!(names(&reply), vec!["Public before race"]);
    assert!(!reply.body.to_string().contains("Private after race"));
    assert!(
        names(
            &first
                .rpc(
                    "files.list",
                    json!({"view":"shared"}),
                    Some(&recipient.cookie)
                )
                .await
        )
        .is_empty()
    );
}
