const PROVISIONED_STATUS = "provisioned";
const MANUAL_STATUS = "manual_required";

function getEmploymentReportChannelGender(formData = {}) {
  const gender = String(formData.gender || "").trim();
  if (gender === "男" || gender.includes("男陪")) return "男";
  if (gender === "女" || gender.includes("女陪")) return "女";
  return null;
}

function isDuplicateKeyError(error) {
  return String(error?.code || "") === "23505";
}

async function ensureEmploymentStaffRecord({
  supabase,
  staffTable,
  signing,
  formData,
  existingStaff,
  channelId,
  gender,
}) {
  const discordId = String(signing.discord_id || "").trim();
  if (!discordId) throw new Error("簽署資料缺少 Discord ID");

  const updateExisting = async () => {
    const { error } = await supabase
      .from(staffTable)
      .update({
        salary_channel_id: String(channelId),
        role_checked: true,
        updated_at: new Date().toISOString(),
      })
      .eq("discord_id", discordId);
    if (error) throw error;
  };

  if (existingStaff) {
    await updateExisting();
    return "updated";
  }

  const discordName =
    String(signing.discord_name || formData.discord_name || discordId).trim() ||
    discordId;
  const { error: insertError } = await supabase.from(staffTable).insert({
    discord_id: discordId,
    discord_username: discordName,
    discord_name: discordName,
    display_name:
      String(formData.display_name || signing.discord_name || discordName).trim() ||
      discordName,
    real_name: formData.real_name || null,
    gender: gender || formData.gender || null,
    birthday: formData.birthday || null,
    bank_name: formData.bank_name || null,
    bank_account: formData.bank_account || null,
    salary_channel_id: String(channelId),
    role_checked: true,
    is_active: true,
    is_online: false,
    can_take_order: true,
  });

  // 員工可能剛好在這一刻首次登入 EIP。若登入流程先建立資料，改為
  // 補上填單區即可，不能把這種競態當成整體失敗。
  if (isDuplicateKeyError(insertError)) {
    await updateExisting();
    return "updated";
  }
  if (insertError) throw insertError;
  return "created";
}

async function provisionSignedEmploymentReportChannels({
  supabase,
  ensureStaffReportChannel,
  organization = "qiunai",
  staffTable = "qiunai_staff",
  discordId = null,
  genderOverride = null,
  reuseSignedAcrossOrganizations = false,
  limit = 1000,
}) {
  if (!supabase || typeof ensureStaffReportChannel !== "function") {
    throw new Error("缺少簽署填單區建立服務");
  }

  let signingQuery = supabase
    .from("employment_contract_signings")
    .select(
      "id, organization_code, discord_id, discord_name, form_data, status, signed_at",
    );
  if (!reuseSignedAcrossOrganizations || !discordId) {
    signingQuery = signingQuery.eq("organization_code", organization);
  }
  signingQuery = signingQuery.in("status", ["signed", "activated"]);
  if (discordId) {
    signingQuery = signingQuery.eq("discord_id", String(discordId));
  }
  const { data, error } = await signingQuery
    .order("signed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  let signingRows = data || [];
  if (reuseSignedAcrossOrganizations && discordId && signingRows.length > 1) {
    signingRows = [
      ...signingRows,
    ].sort((left, right) => {
      const leftOwn = left.organization_code === organization ? 1 : 0;
      const rightOwn = right.organization_code === organization ? 1 : 0;
      if (leftOwn !== rightOwn) return rightOwn - leftOwn;
      return Date.parse(right.signed_at || 0) - Date.parse(left.signed_at || 0);
    }).slice(0, 1);
  }
  const discordIds = [...new Set(signingRows.map((row) => row.discord_id).filter(Boolean))];
  const staffByDiscordId = new Map();
  if (discordIds.length) {
    const { data: staffRows, error: staffError } = await supabase
      .from(staffTable)
      .select("discord_id, discord_name, display_name, real_name, gender, salary_channel_id")
      .in("discord_id", discordIds);
    if (staffError) throw staffError;
    for (const staff of staffRows || []) {
      staffByDiscordId.set(String(staff.discord_id), staff);
    }
  }

  const summary = { checked: 0, provisioned: 0, manualRequired: 0, failed: 0 };
  for (const signing of signingRows) {
    const formData = signing.form_data || {};
    // 跨店共用既有簽署只代表「已完成合法簽署」。另一店的填單區 ID
    // 不能拿來當成本店頻道，也不能覆寫原店的配置紀錄。
    const ownsSigning =
      !signing.organization_code || signing.organization_code === organization;
    const existingStaff =
      staffByDiscordId.get(String(signing.discord_id)) || null;
    const formChannelId = ownsSigning
      ? String(formData.report_channel_id || "").trim()
      : "";
    const staffChannelId = String(existingStaff?.salary_channel_id || "").trim();
    if (
      formChannelId &&
      existingStaff &&
      staffChannelId === formChannelId
    ) {
      continue;
    }
    if (!ownsSigning && existingStaff && staffChannelId) {
      continue;
    }
    summary.checked += 1;

    const gender =
      getEmploymentReportChannelGender(formData) ||
      getEmploymentReportChannelGender(existingStaff || {}) ||
      getEmploymentReportChannelGender({ gender: genderOverride });
    if (!gender && !formChannelId && !staffChannelId) {
      if (ownsSigning && formData.report_channel_status === MANUAL_STATUS) continue;
      if (!ownsSigning) {
        summary.manualRequired += 1;
        continue;
      }
      const nextFormData = {
        ...formData,
        report_channel_status: MANUAL_STATUS,
        report_channel_error: "簽署性別不是男或女，需由管理員選擇填單區分類",
      };
      const { error: updateError } = await supabase
        .from("employment_contract_signings")
        .update({ form_data: nextFormData, updated_at: new Date().toISOString() })
        .eq("id", signing.id);
      if (updateError) throw updateError;
      summary.manualRequired += 1;
      continue;
    }

    try {
      const channel = await ensureStaffReportChannel(
        {
          ...(existingStaff || {}),
          discord_id: signing.discord_id,
          discord_name: existingStaff?.discord_name || signing.discord_name,
          display_name: existingStaff?.display_name || signing.discord_name,
          real_name: existingStaff?.real_name || formData.real_name || null,
          gender: existingStaff?.gender || gender || formData.gender || null,
          salary_channel_id:
            existingStaff?.salary_channel_id || formChannelId || null,
        },
        { sendOnboardingGuide: true },
      );
      if (!channel?.id) throw new Error("建立填單區後未取得頻道 ID");

      await ensureEmploymentStaffRecord({
        supabase,
        staffTable,
        signing,
        formData,
        existingStaff,
        channelId: channel.id,
        gender,
      });

      if (ownsSigning) {
        const nextFormData = {
          ...formData,
          ...(!formData.gender && gender ? { gender } : {}),
          report_channel_id: channel.id,
          report_channel_status: PROVISIONED_STATUS,
          report_channel_created_at:
            formData.report_channel_created_at || new Date().toISOString(),
        };
        delete nextFormData.report_channel_error;
        const { error: updateError } = await supabase
          .from("employment_contract_signings")
          .update({ form_data: nextFormData, updated_at: new Date().toISOString() })
          .eq("id", signing.id);
        if (updateError) throw updateError;
      }
      staffByDiscordId.set(String(signing.discord_id), {
        ...(existingStaff || {}),
        discord_id: String(signing.discord_id),
        salary_channel_id: String(channel.id),
        gender: existingStaff?.gender || gender || formData.gender || null,
      });
      summary.provisioned += 1;
    } catch (provisionError) {
      summary.failed += 1;
      console.error(
        `[入職填單區] <@${signing.discord_id}> 建立失敗`,
        provisionError,
      );
    }
  }

  return summary;
}

module.exports = {
  MANUAL_STATUS,
  PROVISIONED_STATUS,
  getEmploymentReportChannelGender,
  provisionSignedEmploymentReportChannels,
};
