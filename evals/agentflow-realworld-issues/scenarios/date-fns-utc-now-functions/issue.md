# isToday(new UTCDate()) returns false

Source: https://github.com/date-fns/date-fns/issues/3730

`isToday(new UTCDate())` returns `false`, but it should return `true`.

The root problem applies to helpers that compare an input date extension against the current date. They must construct the current date using the same date constructor as the input where appropriate.
