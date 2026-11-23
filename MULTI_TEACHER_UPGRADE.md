# TutorFlow 多老師工作區升級

此版本保存在本機 `codex/multi-teacher-cloud`。正式 GitHub Pages、Firestore、Firebase Auth、LINE Webhook 與 Cloudflare Worker 目前採用既有設定。

## 程式盤點與 LINE 相容性

| 項目 | 原版程式所見 | 多老師版本 |
| --- | --- | --- |
| 管理介面 | 靜態 `index.html`，使用 Firebase Compat CDN | 延用原介面與 CDN。新的雲端模組隨靜態檔部署 |
| 本機資料 | `tutorflow-data-v1` 包含學生、課程、教學紀錄、空堂設定。舊公開快取為 `tutorflow-public-availability-v1` | 舊鍵保留。只有授權擁有人可以在介面上手動下載舊鍵的 JSON |
| 行事曆與收費 | 課程含排課、取消、重複排程、費率快照及收款狀態。教學紀錄以 `courseId`、`studentId` 關聯 | 工作區保留原欄位、ID 及關聯。確認的私人預約亦占用空堂 |
| LINE Bot | Worker 列出根集合 `publicAvailability`，一段一文件。欄位 `date`、`start`、`end`、`status` 皆為字串 | 改為直接讀取 Worker `TEACHER_UID` 對應的一份文件。LINE Bot 仍在聊天室回覆 |
| LIFF | Git 內有公開查詢頁及 LIFF 啟動設定 | 原 URL 保留為相容路徑。此次上線流程以 Bot 在聊天室回覆為主 |

已比對 Firebase Console 截圖、Firestore 公開唯讀結果與你提供的 Worker。來源是 `turtorflow/(default)` 的 `publicAvailability/{時段ID}` 集合。原 Worker 使用未登入 REST 分頁讀取，沒有依老師 UID 過濾。原預約連結會打開官方帳號聊天並帶入預約文字。切換補丁只替換空堂資料讀取及函式呼叫，沿用其餘訊息與路由。請以同一批測試空堂核對正式聊天室的 Flex Message、Quick Reply 和預約連結。

原版硬編碼 UID 出現在 `firebase-config.js` 的登入白名單、`index.html` 未使用的 Rules 範本，以及 `FIREBASE_SETUP.md` 原版文件。新前端以目前 Firebase Auth UID 載入私人工作區。舊測試 UID 現在只留在規則的 LINE 過渡條款、驗證該條款的測試，以及舊版參考文件。新規則排除該 UID 的私人資料與管理員存取。

## 資料及權限

| Firestore 路徑 | 用途與存取 |
| --- | --- |
| `memberships/{uid}` | 老師能查看自己的狀態。手機或 Email 帳號可提出 `teacher/pending` 申請。已核准的管理員可列表、核准與停用老師。Admin 角色及 `legacyImport` 由 Firebase Console 維護 |
| `teachers/{uid}/workspace/head` | 工作區版本、分塊數、操作 ID 與初次遷移標記 |
| `teachers/{uid}/workspace/head/chunks/{index}` | 工作區 JSON 的 UTF-8 分塊。只讀寫已核准本人 UID 的資料，管理員也不能讀其他人的學生資料 |
| `systemSettings/main` | 管理員可開放或暫停新的工作區申請。暫停後，Firebase Auth 仍可產生帳號，Firestore 會拒絕建立申請 |
| `teachers/{uid}/public/publicAvailability` | 每個 UID 只有一份公開空堂文件。其 `slots` 陣列包含原空堂欄位。公開可讀該文件，只有已核准的本人可寫。Rules 不開放同集合列表及私人工作區 |
| `legacyLineBridge/config` | 由 Console 設定 `cutoverComplete: true` 後停止舊測試 UID 的舊集合寫入 |
| `publicAvailability/{slotId}` | 舊集合供切換前使用及比對，保有文件 ID 與所有欄位 |

工作區保留 `students`、`courses`、`notes`、`settings`，另加入 `bookings`。收款以原有課程資料為準。一整筆工作區修改以 Firestore 交易更新版本與變動分塊。每個開啟的工作區只監聽一份版本文件，版本變更時才重新讀取內容。原子上傳上限為 UTF-8 JSON 3,840,000 bytes。超過時畫面提示匯出，需另行規劃大型工作區儲存策略。分塊及公開 `slots` 內容停用索引，無需複合索引。公開文件的 Rules 限制根欄位及陣列型別。Firestore Rules 無法逐一驗證任意長度陣列中的每個物件，所以應先核對資料後再發布，公開文件只應放空堂資料。

斷線時暫存待同步修改，且只在 Firestore 確認後顯示已儲存。版本衝突時保留草稿，使用者可先匯出草稿再重新載入雲端。暫存鍵具有 Firebase 專案、UID 及草稿識別碼。工作區登入後才讀取，原版 localStorage 裡的資料仍可由同一瀏覽器的擁有人直接存取，請妥善保管使用該裝置的權限與下載的 JSON。

## 本機測試

1. 在專案根目錄執行 `npm ci`、`npm run build`、`npm test`、`npm run test:rules` 及 `npm run test:auth`。使用 Node.js 22 以上與 Java 21。
2. UI 驗收可啟動 `npm run emulators`，另開終端執行 `python -m http.server 8765 --bind 127.0.0.1`。開啟 `http://127.0.0.1:8765/`。本機迴路來源使用 `demo-tutorflow`。
3. 用模擬器建立兩個測試帳號。使用 Auth Emulator 顯示的驗證碼或郵件驗證連結，接著在 Emulator UI 以兩個 UID 建立對應的 active 會員文件。確認另一位老師看不到第一位老師的學生、收款、預約與空堂。開兩個獨立瀏覽器設定檔用同一 UID 測試同步及衝突。

官方文件可查閱 [Firebase Auth 模擬器](https://firebase.google.com/docs/emulator-suite/connect_auth)、[Security Rules 模擬測試](https://firebase.google.com/docs/firestore/security/test-rules-emulator) 與 [Firestore 交易](https://firebase.google.com/docs/firestore/manage-data/transactions)。

本次通過前端語法檢查、9 項單元測試、7 項 Firestore Rules 測試及 2 項 Auth 模擬器測試。涵蓋原資料格式、收款及關聯、原子遷移、跨裝置版本衝突、私有工作區隔離、單份公開文件、Worker 讀取與原有篩選、SMS 錯誤碼、Email 驗證與重設密碼。已唯讀備份並在本機核對原集合的 10 份空堂。內建瀏覽器無法連接本機預覽，實體瀏覽器的完整 UI、正式 SMS/reCAPTCHA、正式 LINE 及已部署的 Worker 仍需驗收。

## 正式部署前檢查

1. 舊版在每個有真實資料的瀏覽器先使用「匯出 JSON」。確認檔案可讀，留存學生、課程、教學紀錄、已收款堂數及空堂設定的基準。確認資料所在的瀏覽器來源與正式網址。
2. 由有權限的 Firebase 擁有人以 Cloud Firestore 匯出保存正式資料，涵蓋 `publicAvailability` 及 Worker 依賴的集合。保留文件 ID、欄位型別與原作業規則，先在隔離的環境核對還原流程。保存正式部署的 Git SHA、現行 Firebase Auth Provider 設定和 LINE 設定。Firestore 管理匯出存取權及計費參見 [匯出與匯入資料](https://firebase.google.com/docs/firestore/manage-data/export-import)。
3. 在 Firebase Console 的 Authentication 啟用 Phone 與 Email/Password，確認 GitHub Pages 的授權網域及 Firebase 預設密碼重設頁。Email 帳號須完成郵件驗證後才能進工作區。正式 SMS 需連結 Cloud Billing 並核對 Blaze、SMS 地區政策、實收簡訊及防濫用設定。測試手機號碼應使用模擬器或測試專案。若 Firestore 強制 App Check，須在測試用網域驗證網頁及既有 Worker 的存取方式後才能上線。參見 [Firebase Phone Authentication](https://firebase.google.com/docs/auth/web/phone-auth) 與 [SMS 計費說明](https://firebase.google.com/docs/auth/faq-and-troubleshooting)。
4. 由擁有人確認真正的登入方式與新正式 UID。保留舊 Auth 帳號和 UID。以 Firebase Console 在 `memberships/{正式UID}` 建立 `role: "admin"`（或老師用 `"teacher"`）、`status: "active"`。只有確定可讀取該瀏覽器舊資料的擁有人才可加布林 `legacyImport: true`。
5. 完成測試、取得批准後，先對照正式 Firestore Rules，把 `firestore.rules` 合併與核對後再發布至正式 `(default)`。依原設定保留相關已部署索引，另外將 `chunks.payload` 設為不索引。待正式 Rules、索引及角色確認後，才合併分支並由 GitHub Pages 從已驗證的分支部署。正式讀取或寫入需驗證 [Firebase 官方規則部署步驟](https://firebase.google.com/docs/firestore/security/get-started)。
6. 按下方切換步驟準備及核對新空堂文件。正式 Worker 完成同一批空堂驗收後，再以 Console 設定 `legacyLineBridge/config.cutoverComplete: true`，停用舊集合寫入。原集合仍可保留供核對或回復。

若日後支援多個 LINE Bot，可為各 Worker 環境配置不同的 `TEACHER_UID`，或以可信任的 LINE Channel 對應表選定 UID。

## LINE Bot 及公開空堂切換

1. 備份 `turtorflow/(default)` 中完整的 `publicAvailability` 集合。以 Firestore REST `listDocuments` 保存所有分頁的 `documents` 陣列及原文件名稱。保留原 Firestore Value 形式的 `fields`，如 `stringValue`、`mapValue` 或 `arrayValue`，不要先轉成一般 JavaScript 型別。
2. 執行 `node scripts/availability-migration.cjs prepare 舊資料備份.json 正式老師UID 審核用目標.json`。這個工具只從本機備份產生新檔。目標是一份包含 `slots` 的文件，每個陣列元素原樣保留一份舊文件的 `fields`。舊文件 ID 仍留在來源及備份。先確認文件內容全可公開，並確認目標目前不存在。
3. 正式確認後，使用具備權限的 Firestore 管理工具建立新文件。若透過 API，使用 `createDocument`，讓目標已存在時報錯。讀回目標的 Firestore REST Document，執行 `node scripts/availability-migration.cjs verify 舊資料備份.json 正式老師UID 讀回目標.json`，核對 UID 路徑、陣列順序、所有欄位及型別。
4. 把你提供的完整 Worker 匯出為本機 `old-worker.mjs`，執行 `node worker/apply-availability-change.cjs old-worker.mjs updated-worker.mjs`。用 diff 核對輸出。補丁會檢查原讀取程式特徵並保留圖文選單、Quick Reply、Flex 及預約訊息流程。新 Worker 只會以環境變數 `TEACHER_UID` 讀取一份文件。選填 `FIREBASE_PROJECT_ID` 與 `FIRESTORE_DATABASE_ID`，預設沿用 `turtorflow/(default)`。沿用目前 LINE 相關 Secrets。
5. 在測試環境比對新舊 Bot 的相同時段回覆與預約連結。確認正式環境切換窗口後再部署新 Worker，Webhook URL 維持原設定。若要切換原公開網頁相容路徑，將 `TUTORFLOW_PUBLIC_TEACHER_UID` 設為同一個 UID。LINE Bot 的回覆本身可獨立完成。
6. 若需要回復，使用保存的原 Worker 版本和舊集合。原文件在切換期間保留，注意並人工核對切換後新文件上的變更，避免復原到過期空堂。任何正式資料回寫或重啟舊寫入須先獲批准。

## 遷移與還原

1. 使用正式 UID 登入。在「設定 → 資料備份」選擇上一版匯出的 JSON。若使用同一個來源且有 `legacyImport` 權限，也可先用「下載此瀏覽器的舊資料」取得備份。
2. 匯入前會顯示目標 UID、學生、課程、教學紀錄、預約、收款和找不到關聯的數量。只有在核對擁有權後才確認。已有雲端資料時，系統會先下載目前工作區，再執行明確的整份還原。首次遷移使用版本交易，成功後會重讀並核對完整內容。
3. 若無法確認匯入結果，先重新載入雲端。內容已一致時無須重做；內容未寫入時可用原 JSON 重試。若另一台裝置有較新資料，先匯出兩份版本並比較，再決定是否還原。
4. 開另一台裝置，以相同 UID 核對課程日期、學生與教學紀錄的關聯、收款狀態及空堂。原版 localStorage 和原始 JSON 應保留至驗收和還原測試完成。
5. 若需回到舊網站，先匯出所有有變更的雲端工作區，依批准的回復程序恢復舊版 Git 提交及相容規則。保留新雲端資料和備份。LINE 寫入授權出錯時由 Console 核對橋接設定及原有資料，還原前避免讓固定測試憑證重新取得正式資料存取。不得自動清除新版資料或將新 UID 覆寫至舊帳號。

## 修改檔案

- `index.html`、`firebase-config.js` 保留原管理、空堂計算和部署架構，改用雲端帳號與資料。
- `tutorflow-cloud.js`、`tutorflow-cloud-ui.js` 實作儲存交易、遷移、核准、帳號設定、私人預約與草稿回復。`tutorflow-availability.js` 負責每位老師的公開空堂文件。
- `worker/availability.mjs` 和 `worker/apply-availability-change.cjs` 提供 Worker 讀取變更。`scripts/availability-migration.cjs` 準備及驗證本機備份轉換。
- `firestore.rules`、`firestore.indexes.json`、`firebase.json` 提供待審規則、索引及本機設定。
- `package.json`、`package-lock.json`、`tests/`、`.gitignore` 提供可重跑的本機驗證。
