use super::{account, folder, setup, share};
use crate::support::{Postgres, TestServer};
use hyori_server::db::sql;
use sea_orm::ConnectionTrait;
use serde_json::{Value, json};

#[tokio::test]
#[ignore = "real PostgreSQL/HTTP: all six sort orders, ties, deletion and page boundaries"]
async fn sorted_folder_pages_are_total_and_keep_current_authorization() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let owner = setup(&server, &pg.config).await;
    let viewer = account(&server, &owner, "viewer").await;
    let parent = folder(&server, &owner.cookie, None, "Sorting").await;
    let grant = share(&server, &owner, &parent, &viewer, "viewer").await;
    let public = server
        .rpc(
            "shares.create",
            json!({"itemId":parent,"public":true,"role":"viewer"}),
            Some(&owner.cookie),
        )
        .await;
    let token = public.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let resolved = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await;
    resolved.value();
    let public_cookie = resolved.credential();
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,ancestor_ids,updated_at)
         SELECT 'sort-'||lpad(n::text,4,'0'),$1,$2,'Entry '||lpad((310-n)::text,4,'0'),
           CASE WHEN n<=105 THEN 'folder' ELSE 'file' END,
           CASE WHEN n<=105 THEN 0 ELSE n%3 END,'application/octet-stream',jsonb_build_array($2::text),
           '2020-01-01'::timestamptz + (n%4)*interval '1 day'
         FROM generate_series(1,310) n", vec![owner.id.clone().into(), parent.clone().into()],
    )).await.unwrap();
    for (sort, key, descending) in [
        ("nameAsc", "name", false),
        ("nameDesc", "name", true),
        ("sizeAsc", "size", false),
        ("sizeDesc", "size", true),
        ("modifiedAsc", "updatedAt", false),
        ("modifiedDesc", "updatedAt", true),
    ] {
        let mut expected: Vec<Value> = (1..=310)
            .map(|n| {
                json!({
                    "id":format!("sort-{n:04}"), "name":format!("Entry {:04}",310-n),
                    "file":n>105, "size":if n<=105 {0} else {n%3},
                    "updatedAt":format!("2020-01-0{}T00:00:00Z",1+n%4)
                })
            })
            .collect();
        expected.sort_by(|a, b| {
            let group = a["file"].as_bool().cmp(&b["file"].as_bool());
            let order = if key == "size" && a["file"] == false {
                a["name"].as_str().cmp(&b["name"].as_str())
            } else if key == "size" {
                a[key].as_i64().cmp(&b[key].as_i64())
            } else {
                a[key].as_str().cmp(&b[key].as_str())
            }
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()));
            group.then(if descending { order.reverse() } else { order })
        });
        for cookie in [&viewer.cookie, &public_cookie] {
            let mut cursor = Value::Null;
            let mut actual = vec![];
            for page in 0..4 {
                let reply = server
                    .rpc(
                        "files.list",
                        json!({"parentId":parent,"sort":sort,"cursor":cursor}),
                        Some(cookie),
                    )
                    .await;
                let rows = reply.value()["items"].as_array().unwrap();
                assert_eq!(
                    rows.len(),
                    if page == 3 { 10 } else { 100 },
                    "{sort} page {page}"
                );
                assert!(rows.iter().all(|row| row["access"]["canDelete"] == false));
                actual.extend(rows.iter().map(|row| row["id"].clone()));
                cursor = reply.value()["nextCursor"].clone();
                assert_eq!(cursor.is_null(), page == 3);
            }
            // All 105 folders precede all files, including across the first 100-item page.
            assert_eq!(
                actual,
                expected
                    .iter()
                    .map(|row| row["id"].clone())
                    .collect::<Vec<_>>(),
                "{sort}"
            );
        }

        // Value-based continuation must not depend on the boundary row still existing.
        let first = server
            .rpc(
                "files.list",
                json!({"parentId":parent,"sort":sort,"limit":100}),
                Some(&owner.cookie),
            )
            .await;
        let boundary = first.value()["items"][99]["id"].as_str().unwrap();
        server
            .rpc("files.trash", json!({"id":boundary}), Some(&owner.cookie))
            .await
            .value();
        let next = server
            .rpc(
                "files.list",
                json!({"parentId":parent,"sort":sort,"cursor":first.value()["nextCursor"]}),
                Some(&viewer.cookie),
            )
            .await;
        assert_eq!(
            next.value()["items"][0]["id"],
            expected[100]["id"],
            "{sort}: deleted boundary"
        );
        // New entries before the cursor stay behind us; entries after it remain discoverable.
        server.state.db.execute_raw(sql(
            "INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,mime_type,ancestor_ids,updated_at)
             VALUES ('sort-0000',$1,$2,'AAA inserted','folder','inode/directory',jsonb_build_array($2::text),'2000-01-01'),
                    ('sort-9999',$1,$2,'zzz inserted','folder','inode/directory',jsonb_build_array($2::text),'2100-01-01')",
            vec![owner.id.clone().into(),parent.clone().into()],
        )).await.unwrap();
        let changed = server
            .rpc(
                "files.list",
                json!({"parentId":parent,"sort":sort,"cursor":first.value()["nextCursor"]}),
                Some(&viewer.cookie),
            )
            .await;
        let ids: Vec<_> = changed.value()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        let (before, after) = if descending {
            ("sort-9999", "sort-0000")
        } else {
            ("sort-0000", "sort-9999")
        };
        assert!(!ids.contains(&before), "{sort}: insertion before cursor");
        assert!(ids.contains(&after), "{sort}: insertion after cursor");
        server
            .state
            .db
            .execute_unprepared("DELETE FROM hyori_items WHERE id IN ('sort-0000','sort-9999')")
            .await
            .unwrap();
        server
            .rpc("files.restore", json!({"id":boundary}), Some(&owner.cookie))
            .await
            .value();
        // Restore touches updated_at. Reinstall the synthetic time before the next order.
        server.state.db.execute_raw(sql("UPDATE hyori_items SET updated_at='2020-01-01'::timestamptz + (substring(id from 6)::int%4)*interval '1 day' WHERE id=$1",vec![boundary.into()])).await.unwrap();
        let other_sort = if sort == "nameAsc" {
            "nameDesc"
        } else {
            "nameAsc"
        };
        let mismatch = server
            .rpc(
                "files.list",
                json!({"parentId":parent,"sort":other_sort,"cursor":first.value()["nextCursor"]}),
                Some(&viewer.cookie),
            )
            .await;
        mismatch.error(400, "input.invalid");
        assert_eq!(
            mismatch.body["error"]["message"],
            "Cursor sort does not match the requested sort; start a new listing"
        );
        server
            .rpc("files.list", json!({"parentId":parent,"sort":sort}), None)
            .await
            .error(401, "auth.required");
    }
    server
        .rpc(
            "files.list",
            json!({"parentId":parent,"sort":"name; DROP TABLE hyori_items"}),
            Some(&owner.cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc(
            "files.list",
            json!({"parentId":parent,"sort":"sizeAsc","cursor":"bad cursor"}),
            Some(&owner.cookie),
        )
        .await
        .error(400, "input.invalid");
    server
        .rpc("shares.revoke", json!({"id":grant}), Some(&owner.cookie))
        .await
        .value();
    server
        .rpc(
            "files.list",
            json!({"parentId":parent,"sort":"nameAsc"}),
            Some(&viewer.cookie),
        )
        .await
        .error(403, "access.denied");
}

#[tokio::test]
#[ignore = "real PostgreSQL/HTTP: duplicate shared-root names straddle a 100-item page"]
async fn sorted_shared_roots_break_name_ties_with_id() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let owner = setup(&server, &pg.config).await;
    let viewer = account(&server, &owner, "viewer").await;
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_items(id,owner_id,name,kind,mime_type) SELECT 'tie-parent-'||n,$1,'Parent '||n,'folder','inode/directory' FROM generate_series(1,103) n;
        ",vec![owner.id.clone().into()])).await.unwrap();
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,mime_type,ancestor_ids) SELECT 'tie-'||lpad(n::text,3,'0'),$1,'tie-parent-'||n,CASE WHEN n%2=0 THEN 'Same name' ELSE 'sAME NAME' END,'file','text/plain',jsonb_build_array('tie-parent-'||n) FROM generate_series(1,103) n",vec![owner.id.clone().into()])).await.unwrap();
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_shares(id,item_id,issuer_id,recipient_id,public,role) SELECT 'tie-share-'||n,'tie-'||lpad(n::text,3,'0'),$1,$2,false,'viewer' FROM generate_series(1,103) n",vec![owner.id.into(),viewer.id.into()])).await.unwrap();
    // A direct grant and a consented public grant reach the same item. Membership, not the
    // number of eligible grants, determines how often that item appears in a page.
    let public = server
        .rpc(
            "shares.create",
            json!({"itemId":"tie-001","public":true,"role":"viewer"}),
            Some(&owner.cookie),
        )
        .await;
    let token = public.value()["url"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let resolved = server
        .rpc("shares.resolve", json!({"token":token}), None)
        .await;
    resolved.value();
    let cookie = format!("{}; {}", viewer.cookie, resolved.credential());
    for (sort, descending) in [
        ("nameAsc", false),
        ("nameDesc", true),
        ("sizeAsc", false),
        ("sizeDesc", true),
        ("modifiedAsc", false),
        ("modifiedDesc", true),
    ] {
        let first = server
            .rpc(
                "files.list",
                json!({"view":"shared","sort":sort}),
                Some(&cookie),
            )
            .await;
        let next = server
            .rpc(
                "files.list",
                json!({"view":"shared","sort":sort,"cursor":first.value()["nextCursor"]}),
                Some(&cookie),
            )
            .await;
        let ids: Vec<_> = first.value()["items"]
            .as_array()
            .unwrap()
            .iter()
            .chain(next.value()["items"].as_array().unwrap())
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        let mut expected: Vec<_> = (1..=103).map(|n| format!("tie-{n:03}")).collect();
        if descending {
            expected.reverse();
        }
        assert_eq!(ids, expected, "{sort}");
        assert!(next.value()["nextCursor"].is_null());
    }
}

#[tokio::test]
#[ignore = "real PostgreSQL/HTTP: size orders name folders and keep file ties in ID order"]
async fn size_orders_name_folders_across_page_boundaries() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let owner = setup(&server, &pg.config).await;
    let parent = folder(&server, &owner.cookie, None, "Size folder names").await;
    server.state.db.execute_raw(sql(
        "INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,ancestor_ids)
         SELECT id,$1,$2,name,kind,size,'application/octet-stream',jsonb_build_array($2::text)
         FROM (VALUES ('f-01','Zebra','folder',0),('f-02','Alpha','folder',0),('f-03','alpha','folder',0),
                      ('f-04','Beta','folder',0),('f-05','beta','folder',0),
                      ('file-z','aaa','file',9),('file-a','zzz','file',9)) v(id,name,kind,size)",
        vec![owner.id.into(),parent.clone().into()],
    )).await.unwrap();
    for (sort, expected) in [
        (
            "sizeAsc",
            ["f-02", "f-03", "f-04", "f-05", "f-01", "file-a", "file-z"],
        ),
        (
            "sizeDesc",
            ["f-01", "f-05", "f-04", "f-03", "f-02", "file-z", "file-a"],
        ),
    ] {
        let mut cursor = Value::Null;
        let mut ids = vec![];
        loop {
            let reply = server
                .rpc(
                    "files.list",
                    json!({"parentId":parent,"sort":sort,"limit":3,"cursor":cursor}),
                    Some(&owner.cookie),
                )
                .await;
            ids.extend(
                reply.value()["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["id"].as_str().unwrap().to_owned()),
            );
            cursor = reply.value()["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(ids, expected, "{sort}");
    }
}
