const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseHttpUrl,
  isPrivateIp,
  isBlockedHostname,
  UnsafeUrlError,
} = require("../src/ssrf-guard");

test("拒绝非 http/https 协议", () => {
  for (const url of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)"]) {
    assert.throws(() => parseHttpUrl(url), UnsafeUrlError);
  }
});

test("拒绝携带账号密码的链接", () => {
  assert.throws(() => parseHttpUrl("http://user:pass@example.com/"), UnsafeUrlError);
});

test("本机与内网 IP 一律视为禁止访问", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ];
  for (const ip of blocked) {
    assert.ok(isPrivateIp(ip), `应该拒绝 ${ip}`);
  }
});

test("公网 IP 不视为内网地址", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "114.114.114.114", "2606:4700:4700::1111"]) {
    assert.ok(!isPrivateIp(ip), `不应拒绝 ${ip}`);
  }
});

test("本地域名与云元数据域名被拦截", () => {
  for (const host of [
    "localhost",
    "app.localhost",
    "foo.local",
    "bar.internal",
    "metadata.google.internal",
    "home.lan",
  ]) {
    assert.ok(isBlockedHostname(host), `应该拦截 ${host}`);
  }
  assert.ok(!isBlockedHostname("example.com"));
});

test("内网链接在发起请求前就会被拒绝", () => {
  const cases = [
    "http://127.0.0.1:3000/api/health",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.10/admin",
  ];
  for (const url of cases) {
    const parsed = parseHttpUrl(url);
    const blockedByHostname = isBlockedHostname(parsed.hostname);
    const blockedByIp = isPrivateIp(parsed.hostname);
    assert.ok(blockedByHostname || blockedByIp, `应该拦截 ${url}`);
  }
});

