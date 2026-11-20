mod support;

use hyori_server::auth::random_token;
use sea_orm::ConnectionTrait;
use serde_json::json;
use sha2::Digest;
use support::{Postgres, TestServer};
use yrs::{
    Doc, GetString, ReadTxn, Text, Transact, Update, XmlFragment, XmlOut, XmlTextPrelim,
    updates::decoder::Decode,
};

#[tokio::test]
#[ignore = "requires Docker PostgreSQL"]
async fn notes_inherit_shares_commit_batches_and_fence_restored_or_revoked_sessions() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let password = random_token();
    let setup = server.rpc("auth.setup", json!({"email":"owner@example.test","name":"Owner","password":password,"setupToken":pg.config.setup_token}), None).await;
    assert!(setup.cookie.is_some());
    let owner = setup.credential();
    server
        .rpc(
            "notes.create",
            json!({"parentId":null,"name":"Untitled note"}),
            Some(&owner),
        )
        .await
        .value();
    // Allocation is server-owned, independent of the caller's filtered/paginated library.
    let (first, second) = tokio::join!(
        server.rpc("notes.create", json!({"parentId":null}), Some(&owner)),
        server.rpc("notes.create", json!({"parentId":null}), Some(&owner))
    );
    let mut names = vec![
        first.value()["file"]["name"].clone(),
        second.value()["file"]["name"].clone(),
    ];
    names.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    assert_eq!(
        names,
        vec![json!("Untitled note 2"), json!("Untitled note 3")]
    );
    server
        .rpc(
            "notes.create",
            json!({"parentId":null,"name":"Untitled note"}),
            Some(&owner),
        )
        .await
        .error(409, "resource.conflict");
    let member = server
        .rpc(
            "admin.createUser",
            json!({"email":"member@example.test","name":"Member","password":password}),
            Some(&owner),
        )
        .await;
    let member_id = member.value()["id"].clone();
    let login = server
        .rpc(
            "auth.login",
            json!({"email":"member@example.test","password":password}),
            None,
        )
        .await;
    let member = login.credential();
    let note = server
        .rpc(
            "notes.create",
            json!({"name":"Team notes","parentId":null}),
            Some(&owner),
        )
        .await;
    let id = note.value()["file"]["id"].clone();
    let child = server
        .rpc(
            "notes.create",
            json!({"name":"Decisions","parentId":id}),
            Some(&owner),
        )
        .await;
    let child_id = child.value()["file"]["id"].clone();
    server
        .rpc(
            "files.rename",
            json!({"id":child_id,"name":"Renamed decisions"}),
            Some(&owner),
        )
        .await
        .error(409, "resource.conflict");
    server
        .rpc(
            "files.rename",
            json!({"id":child_id,"name":"Renamed decisions","expectedName":"Decisions"}),
            Some(&owner),
        )
        .await
        .value();
    server
        .rpc(
            "notes.rename",
            json!({"id":child_id,"name":"Stale title","expectedName":"Decisions"}),
            Some(&owner),
        )
        .await
        .error(409, "resource.conflict");
    let share = server
        .rpc(
            "shares.create",
            json!({"itemId":id,"recipientId":member_id,"public":false,"role":"editor"}),
            Some(&owner),
        )
        .await;
    let share_id = share.value()["id"].clone();
    let found = server
        .rpc(
            "files.list",
            json!({"search":"Renamed decisions"}),
            Some(&member),
        )
        .await;
    assert_eq!(found.value()["items"].as_array().unwrap().len(), 1);
    assert_eq!(found.value()["items"][0]["id"], child_id);
    let opened = server
        .rpc(
            "collaboration.open",
            json!({"id":child_id,"clientId":"1001","schemaVersion":1}),
            Some(&member),
        )
        .await;
    let room = opened.value();
    assert_eq!(room["writable"], true);
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut tx = doc.transact_mut();
    tx.apply_update(
        Update::decode_v1(&hex::decode(room["state"].as_str().unwrap()).unwrap()).unwrap(),
    )
    .unwrap();
    let XmlOut::Element(group) = fragment.get(&tx, 0).unwrap() else {
        panic!("missing group");
    };
    let XmlOut::Element(container) = group.get(&tx, 0).unwrap() else {
        panic!("missing block");
    };
    let XmlOut::Element(paragraph) = container.get(&tx, 0).unwrap() else {
        panic!("missing paragraph");
    };
    let vector = tx.state_vector();
    let text = paragraph.push_back(&mut tx, XmlTextPrelim::new("A decision worth keeping"));
    let update = hex::encode(tx.encode_diff_v1(&vector));
    drop(tx);
    let receipt = server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":update,"presence":"{}"}),Some(&member)).await;
    assert_eq!(receipt.value()["acknowledged"], update);
    server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":"","presence":"{\"cursor\":{\"anchor\":\"invalid\",\"head\":null}}"}),Some(&member)).await.error(400,"input.invalid");
    let checkpoint = server
        .rpc("notes.checkpoint", json!({"id":child_id}), Some(&owner))
        .await;
    let checkpoint_id = checkpoint.value()["id"].clone();
    let mut tx = doc.transact_mut();
    let vector = tx.state_vector();
    text.push(&mut tx, " — later edit");
    let update = hex::encode(tx.encode_diff_v1(&vector));
    drop(tx);
    server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":update,"presence":"{}"}),Some(&member)).await.value();
    let restored = server
        .rpc(
            "notes.restoreCheckpoint",
            json!({"id":child_id,"checkpointId":checkpoint_id}),
            Some(&owner),
        )
        .await;
    assert_ne!(restored.value()["generation"], room["generation"]);
    server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":"","presence":"{}"}),Some(&member)).await.error(409,"resource.conflict");
    let current = server
        .rpc(
            "collaboration.open",
            json!({"id":child_id,"clientId":"1002","schemaVersion":1}),
            Some(&member),
        )
        .await;
    let current = current.value();
    let restored_doc = Doc::new();
    let restored_fragment = restored_doc.get_or_insert_xml_fragment("prosemirror");
    let mut tx = restored_doc.transact_mut();
    tx.apply_update(
        Update::decode_v1(&hex::decode(current["state"].as_str().unwrap()).unwrap()).unwrap(),
    )
    .unwrap();
    use yrs::GetString;
    assert!(
        restored_fragment
            .get_string(&tx)
            .contains("A decision worth keeping")
    );
    assert!(!restored_fragment.get_string(&tx).contains("later edit"));
    drop(tx);
    // History stays reachable past the first page; reaching a page boundary must not stop saves.
    for _ in 0..29 {
        server
            .rpc("notes.checkpoint", json!({"id":child_id}), Some(&owner))
            .await
            .value();
    }
    let first = server
        .rpc("notes.history", json!({"id":child_id}), Some(&owner))
        .await;
    assert_eq!(first.value()["items"].as_array().unwrap().len(), 30);
    let older = server
        .rpc(
            "notes.history",
            json!({"id":child_id,"cursor":first.value()["nextCursor"]}),
            Some(&owner),
        )
        .await;
    assert_eq!(older.value()["items"].as_array().unwrap().len(), 1);
    assert_eq!(older.value()["nextCursor"], serde_json::Value::Null);
    server
        .rpc("shares.revoke", json!({"id":share_id}), Some(&owner))
        .await
        .value();
    let denied = server.rpc("collaboration.sync",json!({"sessionId":current["sessionId"],"generation":current["generation"],"vector":"00","update":"","presence":"{}"}),Some(&member)).await;
    assert_ne!(denied.status, 200);
    server
        .rpc("files.trash", json!({"id":id}), Some(&owner))
        .await
        .value();
    assert_ne!(
        server
            .rpc("notes.get", json!({"id":child_id}), Some(&owner))
            .await
            .status,
        200
    );
    let owner_id = setup.value()["id"].as_str().unwrap();
    let before = server.state.db.query_one_raw(hyori_server::db::sql(
        "SELECT used_bytes,(SELECT sum(octet_length(state)) FROM hyori_collab_documents WHERE item_id IN ($2,$3))+(SELECT sum(octet_length(state)) FROM hyori_collab_checkpoints WHERE item_id IN ($2,$3)) AS charge FROM hyori_users WHERE id=$1",
        vec![owner_id.into(),id.as_str().unwrap().into(),child_id.as_str().unwrap().into()]
    )).await.unwrap().unwrap();
    let charge = before.try_get::<i64>("", "charge").unwrap();
    let removed = server
        .rpc("files.deletePermanently", json!({"id":id}), Some(&owner))
        .await;
    assert_eq!(removed.value()["items"], 2);
    assert_eq!(removed.value()["freedBytes"], charge);
    let remaining = server
        .state
        .db
        .query_one_raw(hyori_server::db::sql(
            "SELECT used_bytes FROM hyori_users WHERE id=$1",
            vec![owner_id.into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", "used_bytes")
        .unwrap();
    assert_eq!(
        remaining,
        before.try_get::<i64>("", "used_bytes").unwrap() - charge
    );
    server
        .rpc(
            "admin.setQuota",
            json!({"userId":owner_id,"quotaBytes":remaining}),
            Some(&owner),
        )
        .await
        .value();
    server
        .rpc(
            "notes.create",
            json!({"parentId":null,"name":"Over quota"}),
            Some(&owner),
        )
        .await
        .error(409, "storage.quotaExceeded");
    println!(
        "QUOTA nested-note permanent deletion freed {charge} bytes; new content at exact quota rejected"
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "requires Docker PostgreSQL"]
async fn sixteen_admitted_sessions_can_poll_and_write_concurrently() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let owner = server.rpc("auth.setup", json!({"email":"polling-owner@example.test","name":"Owner","password":random_token(),"setupToken":pg.config.setup_token}), None).await.credential();
    let note = server
        .rpc(
            "notes.create",
            json!({"name":"Concurrent polling","parentId":null}),
            Some(&owner),
        )
        .await;
    let id = note.value()["file"]["id"].clone();
    let mut rooms = Vec::new();
    for client in 0..16 {
        rooms.push(
            server
                .rpc(
                    "collaboration.open",
                    json!({"id":id,"clientId":client.to_string(),"schemaVersion":1}),
                    Some(&owner),
                )
                .await
                .value()
                .clone(),
        );
    }
    server
        .rpc(
            "collaboration.open",
            json!({"id":id,"clientId":"17","schemaVersion":1}),
            Some(&owner),
        )
        .await
        .error(429, "auth.rateLimited");
    for _ in 0..4 {
        let responses = futures_util::future::join_all(rooms.iter().map(|room|server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":"","presence":"{}"}),Some(&owner)))).await;
        for response in responses {
            response.value();
        }
    }
    let updates: Vec<_> = rooms
        .iter()
        .enumerate()
        .map(|(index, room)| {
            let doc = Doc::new();
            let fragment = doc.get_or_insert_xml_fragment("prosemirror");
            let mut tx = doc.transact_mut();
            tx.apply_update(
                Update::decode_v1(&hex::decode(room["state"].as_str().unwrap()).unwrap()).unwrap(),
            )
            .unwrap();
            let vector = tx.state_vector();
            let XmlOut::Element(group) = fragment.get(&tx, 0).unwrap() else {
                panic!("group")
            };
            let XmlOut::Element(container) = group.get(&tx, 0).unwrap() else {
                panic!("container")
            };
            let XmlOut::Element(paragraph) = container.get(&tx, 0).unwrap() else {
                panic!("paragraph")
            };
            paragraph.push_back(&mut tx, XmlTextPrelim::new(format!("writer-{index:02}")));
            hex::encode(tx.encode_diff_v1(&vector))
        })
        .collect();
    let responses = futures_util::future::join_all(rooms.iter().zip(updates).map(|(room,update)|server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":update,"presence":"{}"}),Some(&owner)))).await;
    for response in responses {
        response.value();
    }
    let receipt = server.rpc("collaboration.sync",json!({"sessionId":rooms[0]["sessionId"],"generation":rooms[0]["generation"],"vector":"00","update":"","presence":"{}"}),Some(&owner)).await;
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut tx = doc.transact_mut();
    tx.apply_update(
        Update::decode_v1(&hex::decode(receipt.value()["update"].as_str().unwrap()).unwrap())
            .unwrap(),
    )
    .unwrap();
    for index in 0..16 {
        assert!(
            fragment
                .get_string(&tx)
                .contains(&format!("writer-{index:02}"))
        );
    }
    println!(
        "POLLING 16 admitted; 17th 429; 64 concurrent idle and 16 concurrent writes 200; all writer markers committed"
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "requires Docker PostgreSQL"]
async fn public_link_guests_leave_four_leases_for_signed_in_people() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let owner = server.rpc("auth.setup", json!({"email":"admission-owner@example.test","name":"Owner","password":random_token(),"setupToken":pg.config.setup_token}), None).await.credential();
    let note = server
        .rpc(
            "notes.create",
            json!({"name":"Public admission","parentId":null}),
            Some(&owner),
        )
        .await;
    let id = note.value()["file"]["id"].clone();
    let mut guests = Vec::new();
    for role in ["viewer", "editor"] {
        let share = server
            .rpc(
                "shares.create",
                json!({"itemId":id,"public":true,"role":role}),
                Some(&owner),
            )
            .await;
        let token = share.value()["url"]
            .as_str()
            .unwrap()
            .rsplit('/')
            .next()
            .unwrap();
        guests.push(
            server
                .rpc("shares.resolve", json!({"token":token}), None)
                .await
                .credential(),
        );
    }
    let mut responses = Vec::new();
    for client in 0..16 {
        responses.push(
            server
                .rpc(
                    "collaboration.open",
                    json!({"id":id,"clientId":client.to_string(),"schemaVersion":1}),
                    Some(&guests[client % guests.len()]),
                )
                .await,
        );
    }
    let opened = server
        .rpc(
            "collaboration.open",
            json!({"id":id,"clientId":"100","schemaVersion":1}),
            Some(&owner),
        )
        .await;
    println!(
        "ADMISSION anonymous statuses {:?}; owner {}",
        responses
            .iter()
            .map(|response| response.status)
            .collect::<Vec<_>>(),
        opened.status
    );
    for response in &responses[..12] {
        response.value();
    }
    for response in &responses[12..] {
        response.error(429, "auth.rateLimited");
    }
    let room = opened.value();
    assert_eq!(room["writable"], true);
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let update = {
        let mut tx = doc.transact_mut();
        tx.apply_update(
            Update::decode_v1(&hex::decode(room["state"].as_str().unwrap()).unwrap()).unwrap(),
        )
        .unwrap();
        let vector = tx.state_vector();
        let XmlOut::Element(group) = fragment.get(&tx, 0).unwrap() else {
            panic!("group")
        };
        let XmlOut::Element(container) = group.get(&tx, 0).unwrap() else {
            panic!("container")
        };
        let XmlOut::Element(paragraph) = container.get(&tx, 0).unwrap() else {
            panic!("paragraph")
        };
        paragraph.push_back(&mut tx, XmlTextPrelim::new("Owner can still edit"));
        hex::encode(tx.encode_diff_v1(&vector))
    };
    server.rpc("collaboration.sync", json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":update,"presence":"{}"}), Some(&owner)).await.value();
    for client in 101..104 {
        // Even with a public-link cookie, an active account is still signed in.
        let credentials = format!("{owner}; {}", guests[0]);
        server
            .rpc(
                "collaboration.open",
                json!({"id":id,"clientId":client.to_string(),"schemaVersion":1}),
                Some(&credentials),
            )
            .await
            .value();
    }
    server
        .rpc(
            "collaboration.open",
            json!({"id":id,"clientId":"104","schemaVersion":1}),
            Some(&owner),
        )
        .await
        .error(429, "auth.rateLimited");
    server
        .rpc(
            "collaboration.open",
            json!({"id":id,"clientId":"105","schemaVersion":1}),
            Some(&guests[0]),
        )
        .await
        .error(429, "auth.rateLimited");
    let receipt = server.rpc("collaboration.sync", json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":"","presence":"{}"}), Some(&owner)).await;
    let committed = Doc::new();
    let content = committed.get_or_insert_xml_fragment("prosemirror");
    let mut tx = committed.transact_mut();
    tx.apply_update(
        Update::decode_v1(&hex::decode(receipt.value()["update"].as_str().unwrap()).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert!(content.get_string(&tx).contains("Owner can still edit"));
    let counts = server.state.db.query_one_raw(hyori_server::db::sql("SELECT count(*) AS total,count(*) FILTER (WHERE starts_with(principal,'guest:')) AS guests FROM hyori_collab_sessions WHERE item_id=$1",vec![id.as_str().unwrap().into()])).await.unwrap().unwrap();
    assert_eq!(counts.try_get::<i64>("", "total").unwrap(), 16);
    assert_eq!(counts.try_get::<i64>("", "guests").unwrap(), 12);
    println!(
        "ADMISSION 12 unsigned across two public links; 13th unsigned 429; owner opens and commits text; four signed-in leases including combined cookies; total 16; all further opens 429"
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "requires Docker PostgreSQL"]
async fn notes_reject_executable_content_without_mutating_the_stored_head() {
    use std::collections::HashMap;
    use yrs::{Any, Xml, XmlElementPrelim};
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let setup = server.rpc("auth.setup", json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":pg.config.setup_token}), None).await;
    let owner = setup.credential();
    let note = server
        .rpc(
            "notes.create",
            json!({"name":"Content safety","parentId":null}),
            Some(&owner),
        )
        .await;
    let id = note.value()["file"]["id"].clone();
    let opened = server
        .rpc(
            "collaboration.open",
            json!({"id":id,"clientId":"234","schemaVersion":1}),
            Some(&owner),
        )
        .await;
    let room = opened.value();
    let initial = hex::decode(room["state"].as_str().unwrap()).unwrap();
    for attack in [
        "script",
        "iframe",
        "event-attribute",
        "style-attribute",
        "javascript-link",
        "data-link",
        "https-link",
    ] {
        let doc = Doc::new();
        let fragment = doc.get_or_insert_xml_fragment("prosemirror");
        let mut tx = doc.transact_mut();
        tx.apply_update(Update::decode_v1(&initial).unwrap())
            .unwrap();
        let vector = tx.state_vector();
        let XmlOut::Element(group) = fragment.get(&tx, 0).unwrap() else {
            panic!("group")
        };
        let XmlOut::Element(container) = group.get(&tx, 0).unwrap() else {
            panic!("container")
        };
        let XmlOut::Element(paragraph) = container.get(&tx, 0).unwrap() else {
            panic!("paragraph")
        };
        match attack {
            "script" | "iframe" => {
                paragraph.push_back(&mut tx, XmlElementPrelim::empty(attack));
            }
            "event-attribute" => {
                paragraph.insert_attribute(&mut tx, "onclick", "alert(1)");
            }
            "style-attribute" => {
                paragraph.insert_attribute(&mut tx, "style", "position:fixed");
            }
            _ => {
                let text = paragraph.push_back(&mut tx, XmlTextPrelim::new("A link"));
                let href = match attack {
                    "javascript-link" => "javascript:alert(1)",
                    "data-link" => "data:text/html,<script>alert(1)</script>",
                    _ => "https://example.test/allowed",
                };
                text.format(
                    &mut tx,
                    0,
                    6,
                    HashMap::from([(
                        "link".into(),
                        Any::Map(std::sync::Arc::new(HashMap::from([(
                            "href".into(),
                            Any::String(href.into()),
                        )]))),
                    )]),
                );
            }
        }
        let update = hex::encode(tx.encode_diff_v1(&vector));
        drop(tx);
        let response = server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":update,"presence":"{}"}),Some(&owner)).await;
        println!("CONTENT {attack} {}", response.status);
        if attack == "https-link" {
            response.value();
        } else {
            response.error(400, "input.invalid");
            let stored = server
                .state
                .db
                .query_one_raw(hyori_server::db::sql(
                    "SELECT state FROM hyori_collab_documents WHERE item_id=$1",
                    vec![id.as_str().unwrap().into()],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<Vec<u8>>("", "state")
                .unwrap();
            assert_eq!(stored, initial, "rejected content changed stored head");
        }
    }
    pg.stop();
}

#[tokio::test]
#[ignore = "requires Docker PostgreSQL"]
async fn notes_roles_reject_content_writes_and_preserve_public_link_capabilities() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let password = random_token();
    let setup = server.rpc("auth.setup", json!({"email":"owner@example.test","name":"Owner","password":password,"setupToken":pg.config.setup_token}), None).await;
    let owner = setup.credential();
    let note = server
        .rpc(
            "notes.create",
            json!({"parentId":null,"name":"Matrix"}),
            Some(&owner),
        )
        .await;
    let id = note.value()["file"]["id"].clone();
    let checkpoint = server
        .rpc("notes.checkpoint", json!({"id":id}), Some(&owner))
        .await;
    let checkpoint = checkpoint.value()["id"].clone();
    let download = server
        .rpc("files.download", json!({"id":id}), Some(&owner))
        .await;
    let url = download.value()["url"].as_str().unwrap();
    let mut principals = vec![("owner".to_owned(), Some(owner.clone()), true, true, true)];
    for role in [
        "editor",
        "viewer",
        "outsider",
        "revoked-editor",
        "revoked-viewer",
    ] {
        let account = server
            .rpc(
                "admin.createUser",
                json!({"email":format!("{role}@example.test"),"name":role,"password":password}),
                Some(&owner),
            )
            .await;
        let account_id = account.value()["id"].clone();
        let login = server
            .rpc(
                "auth.login",
                json!({"email":format!("{role}@example.test"),"password":password}),
                None,
            )
            .await;
        if role != "outsider" {
            let share = server
                .rpc(
                    "shares.create",
                    json!({"itemId":id,"recipientId":account_id,"public":false,"role":role.strip_prefix("revoked-").unwrap_or(role)}),
                    Some(&owner),
                )
                .await;
            share.value();
            if role.starts_with("revoked-") {
                server
                    .rpc(
                        "shares.revoke",
                        json!({"id":share.value()["id"]}),
                        Some(&owner),
                    )
                    .await
                    .value();
            }
        }
        principals.push((
            role.to_owned(),
            Some(login.credential()),
            matches!(role, "editor" | "viewer"),
            role == "editor",
            false,
        ));
    }
    principals.push(("anonymous".into(), None, false, false, false));
    for role in ["viewer", "editor"] {
        for protected in [false, true] {
            let mut input = json!({"itemId":id,"public":true,"role":role});
            if protected {
                input["password"] = json!(password);
            }
            let share = server.rpc("shares.create", input, Some(&owner)).await;
            let token = share.value()["url"]
                .as_str()
                .unwrap()
                .rsplit('/')
                .next()
                .unwrap();
            if protected {
                let locked = server
                    .rpc("shares.resolve", json!({"token":token}), None)
                    .await;
                assert_eq!(locked.value()["requiresPassword"], true);
                assert!(locked.cookies.is_empty());
            }
            let mut input = json!({"token":token});
            if protected {
                input["password"] = json!(password);
            }
            let access = server
                .rpc(
                    if protected {
                        "shares.unlock"
                    } else {
                        "shares.resolve"
                    },
                    input,
                    None,
                )
                .await;
            access.value();
            let cookie = access.credential();
            principals.push((
                format!("public-{role}-password-{protected}"),
                Some(cookie.clone()),
                true,
                role == "editor",
                false,
            ));
            // A valid native URL still requires the current link credential at byte delivery.
            let response = server
                .client
                .get(format!("{}{url}", server.url))
                .header("host", "localhost:3001")
                .header("origin", "http://localhost:3001")
                .header("cookie", &cookie)
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                200,
                "public native download: {}",
                response.text().await.unwrap()
            );
            // Separate links provide revoked/expired credentials without changing the active cases.
            let dead = server
                .rpc(
                    "shares.create",
                    json!({"itemId":id,"public":true,"role":role}),
                    Some(&owner),
                )
                .await;
            let dead_id = dead.value()["id"].clone();
            let dead_access = server
                .rpc(
                    "shares.resolve",
                    json!({"token":dead.value()["url"].as_str().unwrap().rsplit('/').next().unwrap()}),
                    None,
                )
                .await;
            let dead_cookie = dead_access.credential();
            server
                .rpc("shares.revoke", json!({"id":dead_id}), Some(&owner))
                .await
                .value();
            principals.push((
                format!("revoked-{role}-{protected}"),
                Some(dead_cookie),
                false,
                false,
                false,
            ));
        }
    }
    let expired_link = server
        .rpc(
            "shares.create",
            json!({"itemId":id,"public":true,"role":"editor"}),
            Some(&owner),
        )
        .await;
    let expired_id = expired_link.value()["id"].as_str().unwrap();
    let expired = server.rpc("shares.resolve",json!({"token":expired_link.value()["url"].as_str().unwrap().rsplit('/').next().unwrap()}),None).await;
    server
        .state
        .db
        .execute_raw(hyori_server::db::sql(
            "UPDATE hyori_shares SET expires_at=now()-interval '1 second' WHERE id=$1",
            vec![expired_id.into()],
        ))
        .await
        .unwrap();
    principals.push((
        "expired-link".into(),
        Some(expired.credential()),
        false,
        false,
        false,
    ));
    let expiring_account = server
        .rpc(
            "admin.createUser",
            json!({"email":"expired@example.test","name":"Expired","password":password}),
            Some(&owner),
        )
        .await;
    server.rpc("shares.create", json!({"itemId":id,"recipientId":expiring_account.value()["id"],"public":false,"role":"editor"}), Some(&owner)).await.value();
    let expired = server
        .rpc(
            "auth.login",
            json!({"email":"expired@example.test","password":password}),
            None,
        )
        .await;
    server
        .rpc("notes.get", json!({"id":id}), Some(&expired.credential()))
        .await
        .value();
    server.state.db.execute_unprepared("UPDATE hyori_sessions SET expires_at=now()-interval '1 second' WHERE user_id=(SELECT id FROM hyori_users WHERE email='expired@example.test')").await.unwrap();
    principals.push((
        "expired-session".into(),
        Some(expired.credential()),
        false,
        false,
        false,
    ));
    let session = server
        .rpc(
            "collaboration.open",
            json!({"id":id,"clientId":"1","schemaVersion":1}),
            Some(&owner),
        )
        .await;
    let session = session.value();
    let protected = server
        .rpc(
            "collaboration.open",
            json!({"id":id,"clientId":"2","schemaVersion":1}),
            Some(&owner),
        )
        .await;
    let protected_id = protected.value()["sessionId"].as_str().unwrap();
    for (index, (label, cookie, read, write, owns)) in principals.iter().enumerate() {
        let authenticated = matches!(
            label.as_str(),
            "owner" | "editor" | "viewer" | "outsider" | "revoked-editor" | "revoked-viewer"
        );
        let open = server
            .rpc(
                "collaboration.open",
                json!({"id":id,"clientId":(index+100).to_string(),"schemaVersion":1}),
                cookie.as_deref(),
            )
            .await;
        println!("MATRIX {label} collaboration.open {}", open.status);
        assert_eq!(open.status == 200, *read, "{label}: {}", open.body);
        let checks = [
            ("notes.list", json!({}), authenticated),
            ("notes.get", json!({"id":id}), *read),
            (
                "notes.create",
                json!({"parentId":id,"name":format!("Child {index}")}),
                authenticated && *write,
            ),
            (
                "notes.rename",
                json!({"id":id,"name":"Matrix","expectedName":"Matrix"}),
                *owns,
            ),
            (
                "notes.favorite",
                json!({"id":id,"favorite":true}),
                authenticated && *read,
            ),
            ("notes.history", json!({"id":id}), *owns),
            ("notes.checkpoint", json!({"id":id}), *owns),
            (
                "notes.restoreCheckpoint",
                json!({"id":id,"checkpointId":checkpoint}),
                *owns,
            ),
            (
                "collaboration.sync",
                json!({"sessionId":session["sessionId"],"generation":session["generation"],"vector":"00","update":"","presence":"{}"}),
                *owns,
            ),
            (
                "collaboration.close",
                json!({"sessionId":"not-your-session"}),
                authenticated || *read,
            ),
        ];
        for (operation, input, allowed) in checks {
            let response = server.rpc(operation, input, cookie.as_deref()).await;
            println!("MATRIX {label} {operation} {}", response.status);
            // Restore changes the owner's old generation; even the owner must reopen after it.
            let allowed = allowed && operation != "collaboration.sync";
            assert_eq!(
                response.status == 200,
                allowed,
                "{label} {operation}: {}",
                response.body
            );
            if operation == "notes.list" && allowed {
                assert_eq!(
                    response.value()["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|note| note["file"]["id"] == id),
                    *read,
                    "{label}: list disclosed an inaccessible note or omitted an accessible note"
                );
            }
            if !allowed {
                assert!(
                    matches!(response.status, 401 | 403 | 404 | 409),
                    "{}",
                    response.body
                );
            }
        }
        if !*owns {
            let close = server
                .rpc(
                    "collaboration.close",
                    json!({"sessionId":protected_id}),
                    cookie.as_deref(),
                )
                .await;
            println!("MATRIX {label} cross-principal-close {}", close.status);
            assert_eq!(close.status == 200, authenticated || *read);
            let retained = server
                .state
                .db
                .query_one_raw(hyori_server::db::sql(
                    "SELECT count(*) AS count FROM hyori_collab_sessions WHERE id=$1",
                    vec![protected_id.into()],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<i64>("", "count")
                .unwrap();
            assert_eq!(retained, 1, "{label} closed another principal's session");
        }
        if *read {
            server
                .rpc(
                    "collaboration.close",
                    json!({"sessionId":open.value()["sessionId"]}),
                    cookie.as_deref(),
                )
                .await
                .value();
            let fresh = server
                .rpc(
                    "collaboration.open",
                    json!({"id":id,"clientId":(index+200).to_string(),"schemaVersion":1}),
                    cookie.as_deref(),
                )
                .await;
            let room = fresh.value();
            let initial = hex::decode(room["state"].as_str().unwrap()).unwrap();
            let candidate = Doc::new();
            let fragment = candidate.get_or_insert_xml_fragment("prosemirror");
            let mut tx = candidate.transact_mut();
            tx.apply_update(Update::decode_v1(&initial).unwrap())
                .unwrap();
            let vector = tx.state_vector();
            let XmlOut::Element(group) = fragment.get(&tx, 0).unwrap() else {
                panic!("group")
            };
            let XmlOut::Element(container) = group.get(&tx, 0).unwrap() else {
                panic!("container")
            };
            let XmlOut::Element(paragraph) = container.get(&tx, 0).unwrap() else {
                panic!("paragraph")
            };
            paragraph.push_back(&mut tx, XmlTextPrelim::new(format!("Stored by {label}")));
            let update = hex::encode(tx.encode_diff_v1(&vector));
            drop(tx);
            let sync = server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":update,"presence":"{}"}),cookie.as_deref()).await;
            println!("MATRIX {label} own-session-content-write {}", sync.status);
            if *write {
                sync.value();
            } else {
                sync.error(403, "access.denied");
            }
            let stored = server
                .state
                .db
                .query_one_raw(hyori_server::db::sql(
                    "SELECT state FROM hyori_collab_documents WHERE item_id=$1",
                    vec![id.as_str().unwrap().into()],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<Vec<u8>>("", "state")
                .unwrap();
            assert_eq!(stored != initial, *write, "{label} stored content mutation");
            let presence = server.rpc("collaboration.sync",json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":"","presence":"{\"user\":{\"name\":\"Impersonated owner\",\"color\":\"red\"},\"html\":\"<script>alert(1)</script>\"}"}),cookie.as_deref()).await;
            presence.value();
            let stored = server
                .state
                .db
                .query_one_raw(hyori_server::db::sql(
                    "SELECT presence FROM hyori_collab_sessions WHERE id=$1",
                    vec![room["sessionId"].as_str().unwrap().into()],
                ))
                .await
                .unwrap()
                .unwrap()
                .try_get::<String>("", "presence")
                .unwrap();
            assert!(!stored.contains("Impersonated") && !stored.contains("script"));
            println!("MATRIX {label} presence stores server identity and cursor only");
            server
                .rpc(
                    "collaboration.close",
                    json!({"sessionId":room["sessionId"]}),
                    cookie.as_deref(),
                )
                .await
                .value();
        }
        let current_download = server
            .rpc("files.download", json!({"id":id}), Some(&owner))
            .await;
        let current_url = current_download.value()["url"].as_str().unwrap();
        let response = server
            .client
            .get(format!("{}{current_url}", server.url))
            .header("host", "localhost:3001")
            .header("origin", "http://localhost:3001");
        let response = if let Some(cookie) = cookie {
            response.header("cookie", cookie)
        } else {
            response
        };
        let response = response.send().await.unwrap();
        println!("MATRIX {label} native-download {}", response.status());
        assert_eq!(response.status().is_success(), *read);
    }
    server
        .rpc("files.trash", json!({"id":id}), Some(&owner))
        .await
        .value();
    for phase in ["trashed", "purged"] {
        if phase == "purged" {
            server
                .rpc("files.deletePermanently", json!({"id":id}), Some(&owner))
                .await
                .value();
        }
        for (label, cookie, read, _, _) in &principals {
            let authenticated = matches!(
                label.as_str(),
                "owner" | "editor" | "viewer" | "outsider" | "revoked-editor" | "revoked-viewer"
            );
            let current_public_link = phase == "trashed" && label.starts_with("public-") && *read;
            for (operation, input) in [
                ("notes.get", json!({"id":id})),
                ("notes.create", json!({"parentId":id,"name":"Cannot store"})),
                (
                    "notes.rename",
                    json!({"id":id,"name":"Matrix","expectedName":"Matrix"}),
                ),
                ("notes.favorite", json!({"id":id,"favorite":true})),
                ("notes.history", json!({"id":id})),
                ("notes.checkpoint", json!({"id":id})),
                (
                    "notes.restoreCheckpoint",
                    json!({"id":id,"checkpointId":checkpoint}),
                ),
                (
                    "collaboration.open",
                    json!({"id":id,"clientId":"900","schemaVersion":1}),
                ),
                (
                    "collaboration.sync",
                    json!({"sessionId":session["sessionId"],"generation":session["generation"],"vector":"00","update":"","presence":"{}"}),
                ),
            ] {
                let response = server.rpc(operation, input, cookie.as_deref()).await;
                println!("MATRIX {phase} {label} {operation} {}", response.status);
                assert!(
                    matches!(response.status, 401 | 403 | 404),
                    "{}",
                    response.body
                );
            }
            let list = server.rpc("notes.list", json!({}), cookie.as_deref()).await;
            println!("MATRIX {phase} {label} notes.list {}", list.status);
            assert_eq!(list.status, if authenticated { 200 } else { 401 });
            if list.status == 200 {
                assert!(
                    !list.value()["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|note| note["file"]["id"] == id)
                );
            } else {
                assert!(matches!(list.status, 401 | 403));
            }
            let response = server
                .client
                .get(format!("{}{url}", server.url))
                .header("host", "localhost:3001")
                .header("origin", "http://localhost:3001");
            let response = if let Some(cookie) = cookie {
                response.header("cookie", cookie)
            } else {
                response
            };
            let response = response.send().await.unwrap();
            println!(
                "MATRIX {phase} {label} native-download {}",
                response.status()
            );
            // Missing/trashed items remain indistinguishable even without a live credential.
            assert_eq!(response.status().as_u16(), 404);
            let close = server
                .rpc(
                    "collaboration.close",
                    json!({"sessionId":session["sessionId"]}),
                    cookie.as_deref(),
                )
                .await;
            println!(
                "MATRIX {phase} {label} collaboration.close {}",
                close.status
            );
            assert_eq!(
                close.status,
                if authenticated || current_public_link {
                    200
                } else {
                    401
                }
            );
        }
    }
    pg.stop();
}

#[tokio::test]
#[ignore = "requires Docker PostgreSQL"]
async fn notes_migration_preserves_populated_candidate_database_and_is_repeatable() {
    let pg = Postgres::start().await;
    let db = sea_orm::Database::connect(&pg.config.database_url)
        .await
        .unwrap();
    db.execute_unprepared("CREATE TABLE hyori_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())").await.unwrap();
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut paths: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    paths.sort();
    for path in paths {
        let name = path.file_name().unwrap().to_str().unwrap();
        let version: i32 = name[..4].parse().unwrap();
        if version > 20 {
            continue;
        }
        let source = std::fs::read_to_string(path).unwrap();
        db.execute_unprepared(&source).await.unwrap();
        db.execute_raw(hyori_server::db::sql(
            "INSERT INTO hyori_migrations(version,checksum) VALUES($1,$2)",
            vec![
                version.into(),
                hex::encode(sha2::Sha256::digest(source.as_bytes())).into(),
            ],
        ))
        .await
        .unwrap();
    }
    db.execute_unprepared("INSERT INTO hyori_users(id,email,name,role,quota_bytes) VALUES('preview-owner','preview@example.test','Existing preview owner','admin',10000000);
        INSERT INTO hyori_items(id,owner_id,name,kind,size,mime_type,object_key) VALUES('preview-file','preview-owner','Keep this preview data','file',512,'text/plain','existing-preview-object');
        INSERT INTO hyori_versions(id,file_id,owner_id,object_key,size,mime_type) VALUES('preview-version','preview-file','preview-owner','existing-preview-version',256,'text/plain');
        INSERT INTO hyori_shares(id,item_id,issuer_id,recipient_id,public,role) VALUES('preview-share','preview-file','preview-owner','preview-owner',false,'viewer');").await.unwrap();
    let snapshot = || async {
        db.query_one_raw(hyori_server::db::sql("SELECT jsonb_build_object('users',(SELECT jsonb_agg(to_jsonb(u)) FROM hyori_users u),'items',(SELECT jsonb_agg(to_jsonb(i)) FROM hyori_items i),'versions',(SELECT jsonb_agg(to_jsonb(v)) FROM hyori_versions v),'shares',(SELECT jsonb_agg(to_jsonb(s)) FROM hyori_shares s)) AS snapshot",vec![])).await.unwrap().unwrap().try_get::<serde_json::Value>("","snapshot").unwrap()
    };
    let before = snapshot().await;
    hyori_server::db::migrate(&db).await.unwrap();
    let after = snapshot().await;
    let mut existing = after.clone();
    let item = existing["items"][0].as_object_mut().unwrap();
    for added in [
        "photo_taken_at",
        "photo_offset_minutes",
        "photo_latitude",
        "photo_longitude",
        "photo_probe_due",
        "photo_camera_make",
        "photo_camera_model",
        "photo_width",
        "photo_height",
        "photo_probe_version",
    ] {
        assert!(item.remove(added).is_some());
    }
    assert_eq!(
        item.remove("original_parent_path"),
        Some(serde_json::Value::Null)
    );
    assert_eq!(existing, before);
    hyori_server::db::migrate(&db).await.unwrap();
    assert_eq!(snapshot().await, after);
    let versions = db.query_one_raw(hyori_server::db::sql("SELECT array_to_json(array_agg(version ORDER BY version)) AS versions FROM hyori_migrations",vec![])).await.unwrap().unwrap().try_get::<serde_json::Value>("","versions").unwrap();
    let applied: Vec<i64> = versions
        .as_array()
        .unwrap()
        .iter()
        .map(|version| version.as_i64().unwrap())
        .collect();
    // The merged candidate also supplies sorting and thumbnail migrations 21–23.
    assert_eq!(&applied[..20], &(1..=20).collect::<Vec<_>>());
    assert!(applied.contains(&24));
    assert!(applied.contains(&25));
    assert!(applied.contains(&29));
    assert!(applied.contains(&30));
    println!(
        "MIGRATION populated 0020 -> 0030 twice: existing users, items, versions and shares unchanged"
    );
    pg.stop();
}

#[tokio::test]
#[ignore = "requires Docker PostgreSQL"]
async fn native_note_downloads_hold_admission_until_read_or_abandoned() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use std::time::Duration;
    use tower::ServiceExt;

    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let owner = server.rpc("auth.setup", json!({"email":"download-owner@example.test","name":"Owner","password":random_token(),"setupToken":pg.config.setup_token}), None).await.credential();
    let note = server
        .rpc(
            "notes.create",
            json!({"name":"Bounded native export","parentId":null}),
            Some(&owner),
        )
        .await;
    let id = note.value()["file"]["id"].clone();
    let opened = server
        .rpc(
            "collaboration.open",
            json!({"id":id,"clientId":"90001","schemaVersion":1}),
            Some(&owner),
        )
        .await;
    let room = opened.value();
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut tx = doc.transact_mut();
    tx.apply_update(
        Update::decode_v1(&hex::decode(room["state"].as_str().unwrap()).unwrap()).unwrap(),
    )
    .unwrap();
    let vector = tx.state_vector();
    let XmlOut::Element(group) = fragment.get(&tx, 0).unwrap() else {
        panic!("group")
    };
    let XmlOut::Element(container) = group.get(&tx, 0).unwrap() else {
        panic!("container")
    };
    let XmlOut::Element(paragraph) = container.get(&tx, 0).unwrap() else {
        panic!("paragraph")
    };
    paragraph.push_back(&mut tx, XmlTextPrelim::new("x".repeat(80_000)));
    let update = hex::encode(tx.encode_diff_v1(&vector));
    drop(tx);
    server.rpc("collaboration.sync", json!({"sessionId":room["sessionId"],"generation":room["generation"],"vector":"00","update":update,"presence":"{}"}), Some(&owner)).await.value();
    let download = server
        .rpc("files.download", json!({"id":id}), Some(&owner))
        .await;
    let url = download.value()["url"].as_str().unwrap();
    // Exercise the production router without polling the body: no kernel buffer can silently
    // consume a supposedly stalled reader's bytes and hide early admission release.
    let request = || {
        Request::builder()
            .uri(url)
            .header("cookie", &owner)
            .header("origin", &pg.config.origin)
            .header("host", "localhost:3001")
            .body(Body::empty())
            .unwrap()
    };
    let app = hyori_server::router(server.state.clone());
    let mut held = Vec::new();
    for _ in 0..hyori_server::config::DOWNLOADS_PER_PRINCIPAL {
        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), 200);
        held.push(response);
    }
    assert!(
        held[0].headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("filename*=UTF-8''Bounded%20native%20export.hyori-note.json")
    );
    let refused = app.clone().oneshot(request()).await.unwrap();
    assert_eq!(
        refused.status(),
        503,
        "unread native exports must hold per-principal admission"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), server.state.drain_transfers())
            .await
            .is_err(),
        "unread native exports must hold process-wide admission"
    );
    let bytes = held
        .pop()
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let export: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(export["format"], "hyori-note");
    assert!(export["state"].as_str().unwrap().len() > 160_000);
    let replacement = app.oneshot(request()).await.unwrap();
    assert_eq!(
        replacement.status(),
        200,
        "finishing a body frees admission"
    );
    drop((replacement, held));
    tokio::time::timeout(Duration::from_secs(2), server.state.drain_transfers())
        .await
        .unwrap()
        .unwrap();
    println!(
        "ADMISSION native exports: 8 unread admitted; ninth 503; drain waits; completed/dropped bodies release admission"
    );
    pg.stop();
}
