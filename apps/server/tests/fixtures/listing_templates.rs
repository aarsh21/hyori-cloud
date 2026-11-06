use super::*;
use sea_orm::Value;
use serde_json::json;
use std::collections::BTreeSet;

#[test]
fn listing_statements_bind_every_slot_and_keep_unadopted_scopes_on_baseline() {
    let mut exported = vec![];
    for (view, parent) in [
        ("files", None),
        ("shared", None),
        ("trash", None),
        ("files", Some("fixture-parent")),
        ("shared", Some("fixture-parent")),
        ("trash", Some("fixture-parent")),
    ] {
        for user in [None, Some("fixture-actor")] {
            for mask in 0..64 {
                let search = if mask & 1 != 0 { "'NeEdLe;--" } else { "" };
                let kind = if mask & 2 != 0 { "image" } else { "" };
                let mut wire = json!({"view":view,"parentId":parent,"cursor":"opaque-cursor","search":search,"type":kind,"limit":100});
                for (bit, key, value) in [
                    (4, "after", json!("2000-01-01T00:00:00Z")),
                    (8, "before", json!("2100-01-01T00:00:00Z")),
                    (16, "minSize", json!(0)),
                    (32, "maxSize", json!(12345)),
                ] {
                    if mask & bit != 0 {
                        wire[key] = value;
                    }
                }
                let input: ListFiles = serde_json::from_value(wire.clone()).unwrap();
                let grants = vec!["fixture-grant".to_owned()];
                let statement = listing_statement(&input, user, &grants, parent, 100).unwrap();
                let values = &statement.values.as_ref().unwrap().0;
                let slots: BTreeSet<usize> = statement
                    .sql
                    .split('$')
                    .skip(1)
                    .map(|part| {
                        part.chars()
                            .take_while(char::is_ascii_digit)
                            .collect::<String>()
                            .parse()
                            .unwrap()
                    })
                    .collect();
                assert_eq!(slots, (1..=values.len()).collect(), "{}", statement.sql);
                assert!(!statement.sql.contains("needle"));
                assert!(!statement.sql.contains("fixture-"));
                assert!(!statement.sql.contains("opaque-cursor"));
                let canonical: Vec<Value> = vec![
                    user.into(),
                    serde_json::json!(grants).into(),
                    "opaque-cursor".into(),
                    (view == "trash").into(),
                    (view == "shared").into(),
                    parent.into(),
                    search.to_lowercase().into(),
                    kind.into(),
                    input.after.as_ref().map(|t| t.parse().unwrap()).into(),
                    input.before.as_ref().map(|t| t.parse().unwrap()).into(),
                    input.min_size.as_ref().map(|b| b.0 as i64).into(),
                    input.max_size.as_ref().map(|b| b.0 as i64).into(),
                    101_i64.into(),
                ];
                let fallback =
                    view != "trash" && parent.is_none() && (view != "shared" || !search.is_empty());
                let parameter_slots: Vec<_> = if fallback {
                    assert_eq!(statement.sql, BASELINE_LIST_SQL);
                    assert_eq!(values, &canonical);
                    (1..=13).collect()
                } else {
                    assert_ne!(statement.sql, BASELINE_LIST_SQL);
                    assert_eq!(values.last(), Some(&Value::from(101_i64)));
                    values
                        .iter()
                        .map(|value| {
                            canonical
                                .iter()
                                .position(|original| original == value)
                                .unwrap()
                                + 1
                        })
                        .collect()
                };
                exported.push(json!({
                    "input": {"actor":user,"publicShares":grants,"cursor":"opaque-cursor","view":view,"parent":parent,"search":search,"type":kind,"after":wire.get("after"),"before":wire.get("before"),"minSize":wire.get("minSize"),"maxSize":wire.get("maxSize"),"limit":100},
                    "sql":statement.sql,"parameterSlots":parameter_slots
                }));
            }
        }
    }
    // Optional local evidence export; the ordinary unit test never starts external services.
    if let Some(path) = std::env::var_os("HYORI_LISTING_TEMPLATE_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&exported).unwrap()).unwrap();
    }
}

#[test]
fn listing_keeps_single_row_lookahead_and_rejects_invalid_cursor_or_date() {
    let input: ListFiles = serde_json::from_value(json!({"parentId":"folder","limit":1})).unwrap();
    let statement = listing_statement(&input, Some("owner"), &[], Some("folder"), 1).unwrap();
    assert_eq!(
        statement.values.unwrap().0.last(),
        Some(&Value::from(2_i64))
    );
    for wire in [
        json!({"cursor":"bad cursor!"}),
        json!({"after":"not-a-date"}),
    ] {
        let input: ListFiles = serde_json::from_value(wire).unwrap();
        assert!(listing_statement(&input, Some("owner"), &[], None, 100).is_err());
    }
}
