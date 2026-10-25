# UGREEN 每日影片上傳通知

由秋奈機器人常駐服務執行，台北時間每日 23:30 開始派送；不依賴操作人員電腦或 Codex。

- `QIUNAI_NAS_DAILY_UPLOAD_LINKS_JSON`：雲端環境設定，陣列欄位為 `date`（YYYY-MM-DD）、`url`（UGREEN 檔案收集訪客頁）。屬私人寫入連結，禁止提交實際內容到 Git。
- 舊 `QIUNAI_NAS_UPLOAD_LINKS_JSON` 已清空，禁止回退到 Synology。
- 每天依台北日期選一個收件入口，發給當日有有效接單紀錄、仍在職且在員工群內的陪陪私人填單區；這是日期入口，不是每人的獨立 NAS 資料夾。訪客只能上傳，請填陪陪名稱以便識別。
- 當日接單以秋奈營業群 `play_orders.accepted_at` 的台北日期為準；排除刪除、取消、退款、駁回、打賞及儲值紀錄，依 `assigned_player` 對應接單者。
- 來源群組固定為秋奈員工群 `1513174069087047731`。
- 依 `qiunai_staff.salary_channel_id` 配對在職且仍在群組的陪陪；只送指定日期的 UGREEN 上傳入口。
- 頻道需為文字填單區、拒絕 everyone 檢視並明確允許本人檢視。多人共用或權限不符時跳過，不猜測或建立頻道。
- 23:30–23:59 內每五分鐘可補試一次；同日成功後不再發送。重啟時查閱當日消息與穩定 nonce，避免重複。
- 訊息使用當天台北日期，說明上傳當天影片，不 @everyone、不私訊。
- 缺少當天日期時停止發送、記錄錯誤，不使用昨天或其他 NAS 連結。日期連結到期前需在 UGREEN 建立新收件入口並更新設定；程式不自動擴大外部寫入權限。

預檢（只讀，不發送）：`node scripts/checkNasNotifications.js`

驗證：`node --test test/qiunaiNasUploadNotifications.test.js`

啟動日誌須出現 `[UGREEN 排程已啟用] Asia/Taipei 每日 23:30`。
