# Inconsistent isSlug results with dots

Source: https://github.com/validatorjs/validator.js/issues/2383

`isSlug` is inconsistent when dots appear in the input:

```js
isSlug("i.am.not.a.slug"); // false
isSlug("slug.is.cool"); // true
```

Expected behavior: both dotted values should be invalid slugs, while normal lowercase alphanumeric, hyphen, and underscore slugs remain valid.
