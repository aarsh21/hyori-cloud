mod support;

use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::json;
use support::{Postgres, TestServer};

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: a directly shared file's Editor cannot probe the folder's names by renaming; metadata only"]
async fn directly_shared_file_editor_cannot_probe_private_sibling_names() {
    let pg = Postgres::start().await;
    let server = TestServer::start(pg.config.clone()).await;
    let owner = server.rpc("auth.setup", json!({"email":"owner@example.test","name":"Owner","password":random_token(),"setupToken":pg.config.setup_token}), None).await;
    let owner_id = owner.value()["id"].as_str().unwrap();
    assert!(owner.cookie.is_some());
    let owner_cookie = owner.credential();
    let password = random_token();
    let editor = server
        .rpc(
            "admin.createUser",
            json!({"email":"editor@example.test","name":"Editor","password":password}),
            Some(&owner_cookie),
        )
        .await;
    let editor_id = editor.value()["id"].as_str().unwrap();
    let cookie = server
        .rpc(
            "auth.login",
            json!({"email":"editor@example.test","password":password}),
            None,
        )
        .await
        .credential();
    let parent = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Private"}),
            Some(&owner_cookie),
        )
        .await
        .value()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner_root = server
        .rpc("files.get", json!({"id":parent}), Some(&owner_cookie))
        .await;
    assert_eq!(owner_root.value()["access"]["canRename"], true);
    server
        .rpc(
            "files.rename",
            json!({"id":parent,"name":"Private renamed"}),
            Some(&owner_cookie),
        )
        .await
        .value();
    let file = random_token();
    // As in files_shares.rs, immutable file metadata only; no object storage is exercised.
    server.state.db.execute_raw(sql("INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,object_key,ancestor_ids) SELECT $1,$2,$3,'Shared.txt','file',10,'text/plain',$4,ancestor_ids||jsonb_build_array(id) FROM hyori_items WHERE id=$3", vec![file.clone().into(),owner_id.into(),parent.clone().into(),format!("{owner_id}/objects/{file}").into()])).await.unwrap();
    server
        .rpc(
            "files.createFolder",
            json!({"parentId":parent,"name":"Confidential.txt"}),
            Some(&owner_cookie),
        )
        .await
        .value();
    server
        .rpc(
            "shares.create",
            json!({"itemId":file,"recipientId":editor_id,"public":false,"role":"editor"}),
            Some(&owner_cookie),
        )
        .await
        .value();
    server
        .rpc("files.list", json!({"parentId":parent}), Some(&cookie))
        .await
        .error(403, "access.denied");
    let single_file = server
        .rpc("files.get", json!({"id":file}), Some(&cookie))
        .await;
    assert_eq!(single_file.value()["access"]["canEdit"], true);
    assert_eq!(single_file.value()["access"]["canRename"], false);
    let occupied = server
        .rpc(
            "files.rename",
            json!({"id":file,"name":"Confidential.txt"}),
            Some(&cookie),
        )
        .await;
    let free = server
        .rpc(
            "files.rename",
            json!({"id":file,"name":"Available.txt"}),
            Some(&cookie),
        )
        .await;
    eprintln!(
        "private parent listing=403; occupied sibling rename={} {}; free rename={} {}",
        occupied.status, occupied.body, free.status, free.body
    );
    // A taken name and a free one get the same refusal, so the answer says nothing about the folder.
    occupied.error(403, "access.denied");
    free.error(403, "access.denied");
    assert_eq!(occupied.body, free.body);
    // The owner still renames, and an Editor of the shared folder still renames inside it.
    let owner_file = server
        .rpc("files.get", json!({"id":file}), Some(&owner_cookie))
        .await;
    assert_eq!(owner_file.value()["access"]["canRename"], true);
    assert_eq!(
        server
            .rpc(
                "files.rename",
                json!({"id":file,"name":"Owner renamed.txt"}),
                Some(&owner_cookie),
            )
            .await
            .value()["name"],
        "Owner renamed.txt"
    );
    server
        .rpc(
            "shares.create",
            json!({"itemId":parent,"recipientId":editor_id,"public":false,"role":"editor"}),
            Some(&owner_cookie),
        )
        .await
        .value();
    let folder_root = server
        .rpc("files.get", json!({"id":parent}), Some(&cookie))
        .await;
    assert_eq!(folder_root.value()["access"]["canEdit"], true);
    assert_eq!(folder_root.value()["access"]["canRename"], false);
    server
        .rpc(
            "files.rename",
            json!({"id":parent,"name":"Forbidden"}),
            Some(&cookie),
        )
        .await
        .error(403, "access.denied");
    let contents = server
        .rpc("files.list", json!({"parentId":parent}), Some(&cookie))
        .await;
    let listed_file = contents.value()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == file)
        .unwrap();
    assert_eq!(listed_file["access"]["canRename"], true);
    server
        .rpc(
            "files.rename",
            json!({"id":file,"name":"Confidential.txt"}),
            Some(&cookie),
        )
        .await
        .error(409, "resource.conflict");
    assert_eq!(
        server
            .rpc(
                "files.rename",
                json!({"id":file,"name":"Available.txt"}),
                Some(&cookie),
            )
            .await
            .value()["name"],
        "Available.txt"
    );
    pg.stop();
}
