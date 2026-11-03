const packages = [
  ["crown_half_day", "半日冠", 1920, 6, 12],
  ["crown_one_day", "一日冠", 3720, 12, 24],
  ["crown_three_days", "三日冠", 10920, 36, 72],
  ["crown_week", "週冠", 24920, 84, 168],
  ["crown_month", "月冠", 94520, 336, 720],
  ["crown_suffix_day", "純後綴・一日", 820, 0, 24, false, true],
  ["crown_suffix_three_days", "純後綴・三天", 2120, 0, 72, false, true],
  ["crown_suffix_week", "純後綴・一週", 4520, 0, 168, false, true],
  ["crown_suffix_month", "純後綴・一月", 15920, 0, 720, false, true],
  ["crown_custom", "自定冠", null, null, null, true],
];

module.exports = packages.map(
  ([key, name, price, giftedHours, durationHours, custom, suffixOnly]) => ({
    key,
    name,
    price,
    giftedHours,
    durationHours,
    custom: Boolean(custom),
    suffixOnly: Boolean(suffixOnly),
  }),
);
