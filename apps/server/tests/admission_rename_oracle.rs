mod support;

use hyori_server::{auth::random_token, db::sql};
use sea_orm::ConnectionTrait;
use serde_json::json;
use support::{Postgres, TestServer};

#[tokio::test]
#[ignore = "real HTTP and unique loopback PostgreSQL: reproduce directly shared file rename oracle; metadata only"]
async fn directly_shared_file_editor_can_probe_private_sibling_names() {
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
        "private parent listing=403; occupied sibling rename={} {}; free rename={}",
        occupied.status, occupied.body, free.status
    );
    occupied.error(409, "resource.conflict");
    assert_eq!(free.value()["name"], "Available.txt");
    pg.stop();
}
