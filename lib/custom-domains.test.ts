import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostname } from "./custom-domains";

process.env["SITES_DOMAIN"] = "orble.co";

test("a pasted URL becomes its hostname", () => {
  assert.equal(
    parseHostname(" https://WWW.MyShop.com/path?x=1 "),
    "www.myshop.com",
  );
  assert.equal(parseHostname("www.myshop.com."), "www.myshop.com");
  assert.equal(parseHostname("shop.example.co.uk"), "shop.example.co.uk");
});

test("a root domain is sent to www", () => {
  assert.throws(() => parseHostname("myshop.com"), /www\.myshop\.com/);
});

test("the platform's own domain is refused", () => {
  assert.throws(() => parseHostname("orble.co"), /subdomain/);
  assert.throws(() => parseHostname("foo.orble.co"), /subdomain/);
});

test("what is not a hostname is refused", () => {
  for (const raw of [
    "",
    "not a domain",
    "-bad.example.com",
    "www.my_shop.com",
    "1.2.3.4",
  ]) {
    assert.throws(() => parseHostname(raw), /not a domain name/);
  }
});
