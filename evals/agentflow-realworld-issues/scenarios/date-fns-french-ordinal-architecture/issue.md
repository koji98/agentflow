# Wrong French ordinal translation

Source: https://github.com/date-fns/date-fns/issues/1391

When formatting French dates with `iiii do MMMM yyyy`, date-fns should produce:

```text
jeudi 1er août 2019
jeudi 29 août 2019
```

Instead, dates after the first of the month include the extra ordinal suffix:

```text
jeudi 29ème août 2019
```

The fix should fit the formatting/locale architecture rather than special-casing one final output string.
