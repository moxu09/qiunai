const gifts = [
  ["tip_33_bear_cookie", "小熊棉花糖餅乾", 33],
  ["tip_60_sakura_charm", "櫻花掛飾", 60],
  ["tip_99_fireworks", "煙花", 99],
  ["tip_100_salty_chicken", "鹹酥雞", 100],
  ["tip_150_qie_zhi_bag", "茄芷袋", 150],
  ["tip_180_520_chocolate", "520巧克力小資版", 180],
  ["tip_230_fruit_candy", "水果糖", 230],
  ["tip_270_creme_brulee", "焦糖烤布蕾", 270],
  ["tip_280_puff", "泡芙", 280],
  ["tip_320_matcha_cake", "抹茶蛋糕", 320],
  ["tip_330_strawberry_sundae", "草莓聖代", 330],
  ["tip_360_croissant_girl", "可頌少女🥐", 360],
  ["tip_480_xiaolongbao", "小籠包", 480],
  ["tip_480_stinky_tofu", "臭豆腐", 480],
  ["tip_500_wheel_soul", "輻能戰魂", 500],
  ["tip_500_summer_sun_girl", "夏日陽光少女☀", 500],
  ["tip_580_beef_noodles", "台灣牛肉麵", 580],
  ["tip_888_playful_girl", "俏皮少女", 888],
  ["tip_16888", "明燈三千", 16888],
];

module.exports = gifts.map(([key, name, price]) => ({
  key,
  name,
  price,
  description: `${price} ASD`,
}));
