use axum::http::{HeaderMap, HeaderValue};
use hyori_server::rpc::RequestContext;

fn headers(cookie: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.append("cookie", HeaderValue::from_str(cookie).unwrap());
    headers
}

#[test]
fn independent_grant_cookies_are_parsed_across_header_lines_without_trusting_names() {
    let first = "a".repeat(64);
    let second = "b".repeat(64);
    let mut request = headers(&format!(
        "hyori_session={first}; hyori_grant_{second}={first}"
    ));
    request.append(
        "cookie",
        HeaderValue::from_str(&format!("hyori_grant_{first}={second}")).unwrap(),
    );
    let context = RequestContext::from_headers(&request);
    assert_eq!(context.session.as_deref(), Some(first.as_str()));
    assert_eq!(context.grants, vec![first, second]);
    assert_eq!(context.grant_cookie_names.len(), 2);
}

#[test]
fn duplicate_cookie_names_fail_closed_for_public_grants_not_session_identity() {
    let token = "a".repeat(64);
    let request = headers(&format!(
        "hyori_session={token}; hyori_grant_{token}={token}; hyori_grant_{token}={token}"
    ));
    let context = RequestContext::from_headers(&request);
    assert_eq!(context.session.as_deref(), Some(token.as_str()));
    assert!(context.grants.is_empty());
}

#[test]
fn malformed_cookie_names_never_become_eviction_headers() {
    let token = "a".repeat(64);
    let request = headers(&format!(
        "hyori_grant_short={token}; hyori_grant_{}={token}",
        "z".repeat(64)
    ));
    let context = RequestContext::from_headers(&request);
    assert!(context.grants.is_empty());
    assert!(context.grant_cookie_names.is_empty());
}

#[test]
fn parser_bounds_concurrent_overflow_candidates_before_database_resolution() {
    let mut cookies: Vec<_> = (0..64)
        .map(|n| format!("hyori_grant_{n:064x}={n:064x}"))
        .collect();
    let context = RequestContext::from_headers(&headers(&cookies.join("; ")));
    assert_eq!(context.grants.len(), 64);
    cookies.push(format!("hyori_grant_{:064x}={:064x}", 64, 64));
    let context = RequestContext::from_headers(&headers(&cookies.join("; ")));
    assert!(context.grants.is_empty());
    assert!(context.grant_cookie_names.is_empty());
}

#[test]
fn legacy_aggregate_remains_bounded_and_readable_during_cookie_transition() {
    let tokens: Vec<_> = (0..16).map(|n| format!("{n:064x}")).collect();
    let cookie = format!("hyori_grants={}", tokens.join("."));
    assert_eq!(
        RequestContext::from_headers(&headers(&cookie)).grants.len(),
        16
    );
    let cookie = format!("{cookie}.{:064x}", 16);
    assert!(
        RequestContext::from_headers(&headers(&cookie))
            .grants
            .is_empty()
    );
}

#[test]
fn total_cookie_bytes_are_bounded_across_header_lines() {
    let token = "a".repeat(64);
    let mut request = headers(&format!("hyori_grant_{token}={token}"));
    request.append(
        "cookie",
        HeaderValue::from_str(&format!("other={}", "x".repeat(16 * 1024))).unwrap(),
    );
    let context = RequestContext::from_headers(&request);
    assert!(context.grants.is_empty());
}
