# Escaped newlines break arguments in version 9

Source: https://github.com/sindresorhus/execa/issues/1175

After upgrading from version 8 to 9, escaped newlines in template strings drop characters from arguments.

Reproduction:

```js
await $`404 abc\
def`;
```

Expected command text is close to `404 abc def`. Actual behavior drops the `d` and reports `404 abc ef`.
