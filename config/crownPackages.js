const packages = [
  ["crown_half_day", "半日冠", 1920, 6, 12],
  ["crown_one_day", "一日冠", 3720, 12, 24],
  ["crown_three_days", "三日冠", 10920, 36, 72],
  ["crown_week", "週冠", 24920, 84, 168],
  ["crown_month", "月冠", 94520, 336, 720],
  ["crown_custom", "自定冠", null, null, null, true],
];

module.exports = packages.map(
  ([key, name, price, giftedHours, durationHours, custom]) => ({
    key,
    name,
    price,
    giftedHours,
    durationHours,
    custom: Boolean(custom),
  }),
);
