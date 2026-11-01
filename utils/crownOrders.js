function getCrownPackageByKey(packages, key) {
  return packages.find((item) => item.key === key) || null;
}

function buildCrownOrderItem(data) {
  const suffixText = data.changeSuffixes
    ? `｜陪陪尾綴：「${data.staffSuffix}」`
    : "｜陪陪尾綴：不修改";
  return (
    `冠名單｜${data.crownName}` +
    (data.suffixOnly ? "｜不含存單" : `｜贈送還單 ${data.giftedHours}hrs`) +
    `｜冠名時長 ${data.durationHours}hrs` +
    suffixText
  );
}

function describeCrownPackage(item) {
  if (item.custom) return "價格、存單時數及後綴時長由客服議定";
  return (item.suffixOnly ? "純後綴，不含存單" : `存單 ${item.giftedHours} 小時`) +
    `｜後綴 ${item.durationHours} 小時`;
}

module.exports = {
  describeCrownPackage,
  buildCrownOrderItem,
  getCrownPackageByKey,
};
