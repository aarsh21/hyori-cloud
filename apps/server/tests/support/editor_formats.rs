use super::{
    PDF, descriptor, enable, finish, get, input, open, prepare, put, scalar, setup, upload,
};
use serde_json::json;

#[tokio::test]
#[ignore = "disposable real PostgreSQL/RustFS editor copy names"]
async fn copy_names_are_available_in_the_selected_folder() {
    let (pg, _fs, server, _owner, cookie) = setup().await;
    enable(&server).await;
    let source = upload(&server, &cookie, "Draft.pdf", PDF, None).await;
    let document = open(&server, &cookie, &source).await;
    let request = json!({"sessionId":document["sessionId"],"name":"Draft copy.pdf","parentId":null,"intent":"save-as"});
    let suggest = || server.rpc("editors.suggestCopyName", request.clone(), Some(&cookie));
    assert_eq!(suggest().await.value(), "Draft copy.pdf");
    upload(&server, &cookie, "Draft copy.pdf", PDF, None).await;
    upload(&server, &cookie, "Draft copy (2).pdf", PDF, None).await;
    assert_eq!(suggest().await.value(), "Draft copy (3).pdf");
    assert_eq!(suggest().await.value(), "Draft copy (3).pdf");
    let folder = server
        .rpc(
            "files.createFolder",
            json!({"parentId":null,"name":"Copies"}),
            Some(&cookie),
        )
        .await
        .value()
        .clone();
    let mut elsewhere = request.clone();
    elsewhere["parentId"] = folder["id"].clone();
    assert_eq!(
        server
            .rpc("editors.suggestCopyName", elsewhere, Some(&cookie))
            .await
            .value(),
        "Draft copy.pdf"
    );
    let mut spoofed = request;
    spoofed["sessionId"] = json!("missing-session");
    server
        .rpc("editors.suggestCopyName", spoofed, Some(&cookie))
        .await
        .error(404, "resource.notFound");
    pg.stop();
}

// Locally synthesized ZIP containers, not vendor rendering/fidelity fixtures or product assets.
pub(super) fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut directory = Vec::new();
    for (name, content) in entries {
        let offset = bytes.len() as u32;
        let crc = content.iter().fold(u32::MAX, |mut crc, byte| {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb88320
                } else {
                    crc >> 1
                };
            }
            crc
        }) ^ u32::MAX;
        bytes.extend_from_slice(b"PK\x03\x04");
        for value in [20_u16, 0, 0, 0, 0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [crc, content.len() as u32, content.len() as u32] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for value in [name.len() as u16, 0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(content);
        directory.extend_from_slice(b"PK\x01\x02");
        for value in [20_u16, 20, 0, 0, 0, 0] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        for value in [crc, content.len() as u32, content.len() as u32] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        for value in [name.len() as u16, 0, 0, 0, 0] {
            directory.extend_from_slice(&value.to_le_bytes());
        }
        directory.extend_from_slice(&0_u32.to_le_bytes());
        directory.extend_from_slice(&offset.to_le_bytes());
        directory.extend_from_slice(name.as_bytes());
    }
    let offset = bytes.len() as u32;
    bytes.extend_from_slice(&directory);
    bytes.extend_from_slice(b"PK\x05\x06");
    for value in [0_u16, 0, entries.len() as u16, entries.len() as u16] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&(directory.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&offset.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes
}

#[tokio::test]
#[ignore = "disposable real PostgreSQL/RustFS all four editor format policies"]
async fn four_descriptor_formats_native_conversion_and_export_preserve_source() {
    let (pg, _fs, server, _owner, cookie) = setup().await;
    enable(&server).await;
    let docx = archive(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("word/document.xml", b"<document/>"),
    ]);
    let xlsx = archive(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("xl/workbook.xml", b"<workbook/>"),
    ]);
    let pptx = archive(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("ppt/presentation.xml", b"<presentation/>"),
    ]);
    let native = archive(&[
        ("mimetype", b"application/vnd.storyteller.deckcraft+zip"),
        (
            "presentation.json",
            b"{\"format\":\"deckcraft\",\"version\":1,\"presentation\":{}}",
        ),
    ]);
    for (name, bytes, app) in [
        ("word.docx", docx.as_slice(), "wordcraft"),
        ("grid.xlsx", xlsx.as_slice(), "gridcraft"),
        ("deck.deckcraft", native.as_slice(), "deckcraft"),
        ("pdf.pdf", PDF, "pdfcraft"),
    ] {
        let file = upload(&server, &cookie, name, bytes, None).await;
        let document = open(&server, &cookie, &file).await;
        assert_eq!(document["app"], app);
        if app == "pdfcraft" {
            assert_eq!(document["annotationAuthor"], "Owner");
        } else {
            assert!(document.get("annotationAuthor").is_none());
        }
        let download = descriptor(&server, &cookie, &document).await;
        let response = get(&server, &cookie, download["url"].as_str().unwrap()).await;
        assert_eq!(response.status(), 200, "{name}");
        assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
        let id = prepare(&server, &cookie, input(&document, "roundtrip", bytes)).await;
        assert_eq!(put(&server, &cookie, &id, bytes).await.status(), 200);
        assert_eq!(
            finish(&server, &cookie, &document, "roundtrip").await["revision"],
            "1"
        );
    }
    let source = upload(&server, &cookie, "office.pptx", &pptx, None).await;
    let document = open(&server, &cookie, &source).await;
    assert_eq!(document["replacementName"], serde_json::Value::Null);
    let mut conversion = input(&document, "conversion", &native);
    conversion["name"] = json!("converted.deckcraft");
    server
        .rpc("editors.prepareSave", conversion.clone(), Some(&cookie))
        .await
        .error(400, "input.invalid");
    conversion["intent"] = json!("save-as");
    conversion["destination"] = json!({"parentId":null});
    let id = prepare(&server, &cookie, conversion).await;
    assert_eq!(put(&server, &cookie, &id, &native).await.status(), 200);
    let saved = finish(&server, &cookie, &document, "conversion").await;
    assert_eq!(saved["revision"], document["revision"]);
    assert_ne!(saved["file"]["id"], source["id"]);
    let mut export = input(&document, "export", PDF);
    export["name"] = json!("presentation.pdf");
    export["intent"] = json!("export");
    export["destination"] = json!({"parentId":null});
    let id = prepare(&server, &cookie, export).await;
    assert_eq!(put(&server, &cookie, &id, PDF).await.status(), 200);
    let saved = finish(&server, &cookie, &document, "export").await;
    assert_eq!(saved["revision"], document["revision"]);
    assert_eq!(
        scalar(
            &server,
            "SELECT count(*) AS n FROM hyori_versions WHERE file_id=$1",
            source["id"].as_str().unwrap()
        )
        .await,
        0
    );
    let spoofed = upload(&server, &cookie, "spoof.docx", &xlsx, None).await;
    let document = open(&server, &cookie, &spoofed).await;
    let descriptor = descriptor(&server, &cookie, &document).await;
    assert_eq!(
        get(&server, &cookie, descriptor["url"].as_str().unwrap())
            .await
            .status(),
        400
    );
    pg.stop();
}
