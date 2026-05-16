# Unexpected validation response for `<name>:<port>` URLs

Source: https://github.com/validatorjs/validator.js/issues/2620

`isURL` returns `false` for URLs like `some-hostname:9000` after the 13.15.20 version bump. Version 13.15.15 returned `true`.

Reproduction:

```js
validator.isURL("my-3272-service:9000", {
  require_tld: false,
  require_valid_protocol: false
});
// expected true, actual false
```

Debug context: validator.js 13.15.20, Node.js 22.14.0, Linux.
