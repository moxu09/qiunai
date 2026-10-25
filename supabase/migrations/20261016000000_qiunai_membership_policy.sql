begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Backups are append-only and service-role-only. Never overwrite prior activation data.
create table if not exists public.qiunai_membership_policy_archive (
  version text primary key, activated_at timestamptz not null default now(),
  old_levels jsonb not null, old_points_levels jsonb not null,
  old_reward_function text not null, source_channel_id text not null,
  benefits_automation_status text not null default 'pending'
);
alter table public.qiunai_membership_policy_archive enable row level security;
revoke all on public.qiunai_membership_policy_archive from public,anon,authenticated;
grant all on public.qiunai_membership_policy_archive to service_role;
insert into public.qiunai_membership_policy_archive(version,old_levels,old_points_levels,old_reward_function,source_channel_id)
select '20261016',
 (select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.vip_levels l where guild_id='1206138511535898654'),
 (select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.qiunai_vip_points_levels l),
 pg_get_functiondef('public.qiunai_apply_vip_level_reward(text,text,text,text,text,numeric,jsonb)'::regprocedure),
 '1313770637587644507'
on conflict(version) do nothing;
create table if not exists public.qiunai_membership_grandfather_20261016 (
 guild_id text not null, user_id text not null, previous_state jsonb not null,
 captured_at timestamptz not null default now(), primary key(guild_id,user_id)
);
alter table public.qiunai_membership_grandfather_20261016 enable row level security;
revoke all on public.qiunai_membership_grandfather_20261016 from public,anon,authenticated;
grant all on public.qiunai_membership_grandfather_20261016 to service_role;
insert into public.qiunai_membership_grandfather_20261016(guild_id,user_id,previous_state)
select guild_id,user_id,to_jsonb(v) from public.user_vips v where guild_id='1206138511535898654'
on conflict(guild_id,user_id) do nothing;
alter table public.vip_levels add column if not exists membership_policy_version text;
alter table public.vip_levels add column if not exists invitation_only boolean not null default false;
insert into public.vip_levels(guild_id,level_key,level_name,total_spend_required,single_topup_required,
role_id,sort_order,reward_note,cashback_rate,multi_player_cashback_rate,multi_player_min_count,invitation_only,membership_policy_version)
values
('1206138511535898654','vip0','〢・初見 𝑳𝒗.𝟎',1000,1000,'1559589209692709025',1,'累積消費1,000T或單次購買星雨幣1,000枚**
<:A_cn_05:1237452055615115424> 獲得`殺比死卡池抽獎劵*1`',0,0,0,false,'20261016'),
('1206138511535898654','vip1','〢・初見 𝑳𝒗.𝟏',3000,2800,'1210649576860680252',2,'累積消費3,000T或單次購買星雨幣2,800枚**
<:A_cn_05:1237452055615115424> 每筆消費回饋1%消費點數
<:A_cn_05:1237452055615115424> 獲得`殺比死卡池抽獎劵*2`',1,0,0,false,'20261016'),
('1206138511535898654','vip2','〢・初見 𝑳𝒗.𝟐',6000,5600,'1207687433085526066',3,'累積消費6,000T或單次購買星雨幣5,600枚**
 <:A_cn_02:1237452066629091338> 每筆消費回饋1%消費點數
 <:A_cn_02:1237452066629091338> 獲得自定義𝑻𝑨𝑮+身分組圖標 3日
 <:A_cn_02:1237452066629091338> 獲得`殺比死卡池抽獎劵*2`',1,0,0,false,'20261016'),
('1206138511535898654','vip3','〢・初見 𝑳𝒗.𝟑',13000,11000,'1210177011205668874',4,'累積消費13,000T或單次購買星雨幣11,000枚**
<:A_cn_04:1237452058043613276> 每筆消費回饋1%消費點數
<:A_cn_04:1237452058043613276> 獲得`限定卡池抽獎劵*2`
<:A_cn_04:1237452058043613276> 獲得闆闆個人語音頻道<a:1213580512161964152:1248713195279876146>
<:A_cn_04:1237452058043613276> 獲得免費一首歌',1,0,0,false,'20261016'),
('1206138511535898654','vip4','〢・初見 𝑳𝒗.𝟒',25000,22300,'1210177201811492915',5,'累積消費25,000T或單次購買星雨幣22,300枚**
<:A_cn_01:1237452101509054464> 每筆消費回饋2%消費點數
<:A_cn_01:1237452101509054464> 獲得闆闆個人聊天區 <a:J_cn_b01:1226131128172417066>
<:A_cn_01:1237452101509054464> 獲得免費娛樂/技術/大神單一小時
<:A_cn_01:1237452101509054464> 獲得永久自定義𝑻𝑨𝑮
<:A_cn_01:1237452101509054464> 獲得`限定卡池抽獎劵*2`
<:A_cn_01:1237452101509054464> 任一陪陪的聯繫方式 (需經過陪陪同意)',2,0,0,false,'20261016'),
('1206138511535898654','vip5','〢・初見 𝑳𝒗.𝟓',38000,35000,'1210177474940506122',6,'累積消費38,000T或單次購買星雨幣35,000枚**
<:A_cn_09:1237145584385916978> 每筆消費回饋2%消費點數
<:A_cn_09:1237145584385916978> 獲得闆闆個人禮物頻道
<:A_cn_09:1237145584385916978> 訂製`專屬禮物*1`
<:A_cn_09:1237145584385916978> 解鎖生日限定禮：當日下單享95折',2,0,0,false,'20261016'),
('1206138511535898654','vip6','〢・熟稔 𝑳𝒗.𝟏',66666,63000,'1210177695908896778',7,'累積消費66,666T或單次購買星雨幣63,000枚**
<:A_cn_08:1237145586864488539> 每筆消費回饋3%消費點數
<:A_cn_08:1237145586864488539> 獲得闆闆專屬派單區 <:G_cn_a10:1226109797791957043>
<:A_cn_08:1237145586864488539> 獲得` 秋奈一番賞抽獎劵*1 殺比死卡池抽獎劵*1`
<:A_cn_08:1237145586864488539> 自定義陪玩後綴7日(需經過陪陪同意)
<:A_cn_08:1237145586864488539> 解鎖專屬客服一位 (需經過客服本人同意)
<:A_cn_08:1237145586864488539> 每月首充返利2%
<:A_cn_08:1237145586864488539> 解鎖生日限定禮：當日下單享9折',3,0,0,false,'20261016'),
('1206138511535898654','vip7','〢・熟稔 𝑳𝒗.𝟐',85000,83500,'1247229551373979648',8,'累積消費85,000T或單次購買星雨幣83,500枚**
<:A_cn_10:1237145544057557124> 每筆消費回饋3%消費點數
<:A_cn_10:1237145544057557124> 訂製`專屬禮物*1`
<:A_cn_10:1237145544057557124> 獲得自定義𝑻𝑨𝑮+身分組圖標一個月
<:A_cn_10:1237145544057557124> 獲得`秋奈一番賞抽獎劵*1 限定卡池獎劵*1`
<:A_cn_10:1237145544057557124> 專屬客服修改後綴1個月(需經過客服本人同意)
<:A_cn_10:1237145544057557124> 每月首充返利2%
<:A_cn_10:1237145544057557124> 解鎖生日限定禮：當日下單享9折，一日獨顯置頂𝑻𝑨𝑮+身分組圖標<@&1247238538383065181>
<:A_cn_10:1237145544057557124> 單次點兩個陪以上可享95折優惠(每週限定2次)',3,0,0,false,'20261016'),
('1206138511535898654','vip8','〢・熟稔 𝑳𝒗.𝟑',99999,98800,'1247230114375405579',9,'累積消費99,999T或單次購買星雨幣98,800枚**
<:A_cn_06:1237452043275472937> 每筆消費回饋3%消費點數
<:A_cn_06:1237452043275472937> 獲得陪玩免費半日冠名<:B_cn_11:1237452015098003466>  `價值2xxx`
<:A_cn_06:1237452043275472937> 半年雙人獨顯𝑻𝑨𝑮 +身分組圖標
<:A_cn_06:1237452043275472937> 陪玩`95折優惠券每月*3`
<:A_cn_06:1237452043275472937> 陪玩單筆購買10H加贈1H
<:A_cn_06:1237452043275472937> 每月首充返利3% or 每週首充返利1%',3,0,0,false,'20261016'),
('1206138511535898654','vip9','〢・熟稔 𝑳𝒗.𝟒',131400,123456,'1269203802892800020',10,'累積消費131,400T或者單次購買星雨幣123,456枚**

<:C_cn_02:1237145559769415843> 每筆消費回饋4%消費點數
<:C_cn_02:1237145559769415843> 獲得`秋奈一番賞抽獎劵*3`
<:C_cn_02:1237145559769415843> 獲得免費娛樂/技術/大神單1小時/局
<:C_cn_02:1237145559769415843> 訂製專屬已接單圖示
<:C_cn_02:1237145559769415843> 訂製專屬冠名禮物 (可自訂價格及最低時數)
<:C_cn_02:1237145559769415843> 一年雙人獨顯𝑻𝑨𝑮 +身分組圖標(在糾察隊之上)
<:C_cn_02:1237145559769415843> 每月首充返利3% or 每週首充返利1%
<:C_cn_02:1237145559769415843> 單次點兩個陪以上可享9折優惠(每週限2次限單次使用)
<:C_cn_02:1237145559769415843> 專屬客服修改後綴1個月(需經過客服本人同意)',4,0,0,false,'20261016'),
('1206138511535898654','vip10','〢・熟稔 𝑳𝒗.𝟓',200000,188888,'1273529740598444098',11,'累積消費200000T或單次購買星雨幣188888枚
<:C_cn_01:1237145562265030759> 每筆消費回饋4％消費點數
<:C_cn_01:1237145562265030759> 闆闆全體專屬特別播報
<:C_cn_01:1237145562265030759> 獲得秋奈一番賞抽獎劵*5
<:C_cn_01:1237145562265030759> 贈送陪玩心動值禮物加成雙倍*1
<:C_cn_01:1237145562265030759> 增加與任一陪陪5200的心動值 <a:1195336164354310174:1248713177437442090>
<:C_cn_01:1237145562265030759> 獲得永久自定義𝑻𝑨𝑮+身分組圖標
<:C_cn_01:1237145562265030759> 參與1次秋奈活動策劃+該活動冠名權
<:C_cn_01:1237145562265030759> 每月首充返利3% or 每週充返利1%
<:C_cn_01:1237145562265030759> 每月修改指定一位陪陪後綴一個月(需經過陪陪本人同意)
<:C_cn_01:1237145562265030759> 每月可任選一位指定陪陪免費陪玩單1H/局
<:C_cn_01:1237145562265030759> 單次點兩個陪以上可享9折優惠(每週限5次限單次使用)',4,0,0,false,'20261016'),
('1206138511535898654','vvip1','〢・貴賓 𝑳𝒗.𝟏',334420,304420,'1275121811180228690',12,'累積消費334,420T或單次購買星雨幣304,420枚**
<:E_cn_03:1226961575781339189> 每筆消費回饋5%消費點數
<:E_cn_03:1226961575781339189> 獲得陪玩單`9折優惠卷*2`
<:E_cn_03:1226961575781339189> 訂製專屬冠名圖 (可自訂價格及最低時數)
<:E_cn_03:1226961575781339189> 店內專屬冠名14天<a:J_cn_b05:1207829586717442182>
<:E_cn_03:1226961575781339189> 修改指定二名陪玩後綴一個月(需經過陪陪本人同意)
<:E_cn_03:1226961575781339189> 獲得雙人自定義𝑻𝑨𝑮+身分組圖標三個月
<:E_cn_03:1226961575781339189> 增加與任一陪陪13,140的心動值<a:1195336164354310174:1248713177437442090>',5,0,0,false,'20261016'),
('1206138511535898654','vvip2','〢・貴賓 𝑳𝒗.𝟐',511314,480000,'1275121906084876308',13,'累積消費511,314或單次購買雨幣480,000枚**
<:E_cn_01:1226961599093538928> 每筆消費回饋5%消費點數
<:E_cn_01:1226961599093538928> 專屬客服修改後綴14天
<:E_cn_01:1226961599093538928> 一年雙人獨顯𝑻𝑨𝑮 +身分組圖標
<:E_cn_01:1226961599093538928> 訂製專屬已接單圖示
<:E_cn_01:1226961599093538928> 歷史`永久活動𝑻𝑨𝑮自選*1`
<:E_cn_01:1226961599093538928> 單次點三個陪陪及以上可獲得該次消費額外`2%點數回饋`
<:E_cn_01:1226961599093538928> 贈送`陪玩心動值禮物加成雙倍*1`
<:E_cn_01:1226961599093538928> 每月修改指定三位陪陪前綴一個月(需經過陪陪本人同意)',5,2,3,false,'20261016'),
('1206138511535898654','vvip3','〢・貴賓 𝑳𝒗.𝟑',777777,700000,'1275122057348255805',14,'累積消費777,777T或單次購買星雨幣700,000枚**
<:E_cn_04:1226961572891721799> 每筆消費回饋5%消費點數
<:E_cn_04:1226961572891721799> 全店通用`9折價券*3`
<:E_cn_04:1226961572891721799> 修改指定五位陪陪後綴一週(需經過陪陪本人同意)
<:E_cn_04:1226961572891721799> 單次點三個陪陪及以上可獲得該次消費額外`3%點數回饋`
<:E_cn_04:1226961572891721799> 自選任一次自定義播報 (贈禮/升級播報皆可)
<:E_cn_04:1226961572891721799> 獲得陪玩免費半日冠名一次<:H_cn_c18:1207821074591383582>  `價值2xxx `
<:E_cn_04:1226961572891721799> 增加與任一陪陪20,184的心動值<a:1195336164354310174:1248713177437442090>',5,3,3,false,'20261016'),
('1206138511535898654','vvip4','〢・貴賓 𝑳𝒗.𝟒',921314,820000,'1275122220619927582',15,'累積消費921,314T或單次購買星雨幣820,000枚**
🧁 每筆消費回饋5%消費點數
🧁 店內專屬冠名20天<a:794358091918344222:1256851626258337792>
🧁 訂製一組全套專屬禮物（3個）
🧁 陪玩`9折優惠券*3`
🧁 購買三日冠可享折扣666T
🧁 指定一位陪玩一個月特殊抽成
🧁 店內周邊商品專屬優惠價
🧁 單次消費/購幣滿30,000T 增加指定陪玩心動值13,140<a:1195336164354310174:1248713177437442090>
🧁 專屬客服修改後綴半年(需經過客服本人同意)
🧁增加與任一陪陪25000的心動值<a:1195336164354310174:1248713177437442090>
🧁 全店置頂自訂義特別𝑻𝑨𝑮 3日',5,0,0,false,'20261016'),
('1206138511535898654','vvip5','〢・貴賓 𝑳𝒗.𝟓',1314520,1200000,'1275122360625791036',16,'累積消費1,314,520T或單次購買星雨幣1,200,000枚**
<:F_cn_21:1226959742191009873> 每筆消費回饋5%消費點數
<:F_cn_21:1226959742191009873> 闆闆專屬禮物播報
<:F_cn_21:1226959742191009873> 獲得全店通用`9折優惠券*4`
<:F_cn_21:1226959742191009873> 修改指定十位陪陪後綴三日(需經過陪陪本人同意)
<:F_cn_21:1226959742191009873> 獲得陪玩免費一日冠名<a:pink_gemheart:1298315073634308188> `價值3xxx`
<:F_cn_21:1226959742191009873> 購買店內𝑻𝑨𝑮兩位以上半價
<:F_cn_21:1226959742191009873> 增加與任一陪陪33,440的心動值<a:1195336164354310174:1248713177437442090>
<:F_cn_21:1226959742191009873> 任一陪陪的聯繫方式 (需經過陪陪同意)
<:F_cn_21:1226959742191009873> 贈送陪玩`心動值禮物加成雙倍*1`
<:F_cn_21:1226959742191009873> 自選雙人全店置頂𝑻𝑨𝑮一週',5,0,0,false,'20261016'),
('1206138511535898654','evip','〢・尊榮 𝑬𝑽𝑰𝑷',2954125,1888888,'1318540663675158548',17,'累積消費2,954,125T或單次購買星雨幣1,888,888枚**
<a:pinkflowers3_sdys:1439268004784246844> 每筆消費回饋**7%**消費點數
<a:pinkflowers3_sdys:1439268004784246844> 可綁定三位心儀陪陪專門服務
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂接單圖
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂禮物圖
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂頻道類別
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂全店置頂身分組及圖示
<a:pinkflowers3_sdys:1439268004784246844> 專屬店冠名一個月
<a:pinkflowers3_sdys:1439268004784246844> 獲得 董事長親筆
<a:pinkflowers3_sdys:1439268004784246844> 解鎖現實專屬會員金屬黑卡

**`秋奈陪玩享有永久新增及修改權，福利無法更換，每張折扣券單次只能使用一張，福利不能與限時活動累加使用，每月的會在1號開放領取可選擇是否要領取，95折券適用500元內訂單，9折券適用800元內訂單，8折券適用3,000元內訂單，7折券適用10,000元內訂單，每筆消費限用一張`**',7,0,0,false,'20261016'),
('1206138511535898654','exclusive','〢・至尊星雨聯盟會員',2594199,0,'1513303489470529576',18,'採**邀請制**，限量**20位**
最低門檻：
消費累積**2,594,199**以上或月消費1,000,000以上
邀請標準**綜合評分消費力、信譽程度、參與程度等**，並非滿額即可受邀
<a:pinkflowers3_sdys:1439268004784246844> 無剛性年費
<a:pinkflowers3_sdys:1439268004784246844> 會員期間每月消費平均需大於100,000T/ASD
<a:pinkflowers3_sdys:1439268004784246844> 解鎖專屬私人各平台及電話客服
<a:pinkflowers3_sdys:1439268004784246844> 客服為二對一專屬服務
<a:pinkflowers3_sdys:1439268004784246844> 可綁定三位心儀陪陪專門服務
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂接單圖
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂禮物圖
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂頻道類別
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂派單房
<a:pinkflowers3_sdys:1439268004784246844> 專屬自訂全店置頂身分組及圖示
<a:pinkflowers3_sdys:1439268004784246844> 專屬店冠名
<a:pinkflowers3_sdys:1439268004784246844> 所有訂單回饋5%點數
<a:pinkflowers3_sdys:1439268004784246844> 獲得入會禮Sony WF-1000XM6 及 親筆信
<a:pinkflowers3_sdys:1439268004784246844> 解鎖現實專屬會員金屬黑卡
<a:pinkflowers3_sdys:1439268004784246844> 每年十次的環亞貴賓室或機場接送服務（需預約）',5,0,0,true,'20261016')
on conflict(guild_id,level_key) do update set
level_name=excluded.level_name,total_spend_required=excluded.total_spend_required,
single_topup_required=excluded.single_topup_required,role_id=excluded.role_id,sort_order=excluded.sort_order,
reward_note=excluded.reward_note,cashback_rate=excluded.cashback_rate,
multi_player_cashback_rate=excluded.multi_player_cashback_rate,multi_player_min_count=excluded.multi_player_min_count,
invitation_only=excluded.invitation_only,membership_policy_version=excluded.membership_policy_version;
-- New upgrades no longer grant obsolete lump-sum points or old coupons.
-- The original ASD values remain archived/in-place for explicitly authorized historical backfills.
update public.vip_levels set reward_coupon=null,monthly_keep_required=0
where guild_id='1206138511535898654' and membership_policy_version='20261016';
insert into public.qiunai_vip_points_levels(level_key,total_spend_required,single_topup_required,reward_points,effective_at)
select level_key,total_spend_required,single_topup_required,0,now() from public.vip_levels
where guild_id='1206138511535898654' and membership_policy_version='20261016'
on conflict(level_key) do update set total_spend_required=excluded.total_spend_required,
single_topup_required=excluded.single_topup_required,reward_points=0,effective_at=excluded.effective_at;
-- Renaming does not promote/demote members or rewrite any accumulation.
update public.user_vips v set level_name=l.level_name from public.vip_levels l
where v.guild_id=l.guild_id and v.level_key=l.level_key and v.guild_id='1206138511535898654';
notify pgrst,'reload schema';
commit;
select count(*) as membership_levels,
count(*) filter(where invitation_only) as invitation_only_levels,
(select count(*) from public.qiunai_membership_grandfather_20261016) as preserved_members
from public.vip_levels where guild_id='1206138511535898654' and membership_policy_version='20261016';
