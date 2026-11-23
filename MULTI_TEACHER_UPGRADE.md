# TutorFlow 多老師工作區升級

本文件說明 TutorFlow 的多老師工作區、電子郵件與密碼登入及 LINE Bot 空堂讀取。正式環境設定需依下列順序切換。

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
| `memberships/{uid}` | 已驗證信箱的老師能查看自己的狀態並提出 `teacher/pending` 申請。已核准的管理員可列表、核准與停用老師。Admin 角色及 `legacyImport` 由 Firebase Console 維護 |
| `teachers/{uid}/workspace/head` | 工作區版本、分塊數、操作 ID 與初次遷移標記 |
| `teachers/{uid}/workspace/head/chunks/{index}` | 工作區 JSON 的 UTF-8 分塊。只讀寫已核准本人 UID 的資料，管理員也不能讀其他人的學生資料 |
| `systemSettings/main` | 管理員可開放或暫停新的工作區申請。暫停後，Firebase Auth 仍可產生帳號，Firestore 會拒絕建立申請 |
| `teachers/{uid}/public/publicAvailability` | 每個 UID 只有一份公開空堂文件。其 `slots` 陣列包含原空堂欄位。公開可讀該文件，只有已核准的本人可寫。Rules 不開放同集合列表及私人工作區 |

工作區保留 `students`、`courses`、`notes`、`settings`，另加入 `bookings`。收款以原有課程資料為準。一整筆工作區修改以 Firestore 交易更新版本與變動分塊。每個開啟的工作區只監聽一份版本文件，版本變更時才重新讀取內容。原子上傳上限為 UTF-8 JSON 3,840,000 bytes。超過時畫面提示匯出，需另行規劃大型工作區儲存策略。分塊及公開 `slots` 內容停用索引，無需複合索引。公開文件的 Rules 限制根欄位及陣列型別。Firestore Rules 無法逐一驗證任意長度陣列中的每個物件，所以應先核對資料後再發布，公開文件只應放空堂資料。

斷線時暫存待同步修改，且只在 Firestore 確認後顯示已儲存。版本衝突時保留草稿，使用者可先匯出草稿再重新載入雲端。暫存鍵具有 Firebase 專案、UID 及草稿識別碼。工作區登入後才讀取，原版 localStorage 裡的資料仍可由同一瀏覽器的擁有人直接存取，請妥善保管使用該裝置的權限與下載的 JSON。

## 本機測試

1. 在專案根目錄執行 `npm ci`、`npm run build`、`npm test`、`npm run test:rules` 及 `npm run test:auth`。使用 Node.js 22 以上與 Java 21。
2. UI 驗收可啟動 `npm run emulators`，另開終端執行 `python -m http.server 8765 --bind 127.0.0.1`。開啟 `http://127.0.0.1:8765/`。本機迴路來源使用 `demo-tutorflow`。
3. 用模擬器以電子郵件及密碼申請兩個帳號。使用 Auth Emulator 顯示的信箱驗證連結，接著在 Emulator UI 以兩個 UID 建立對應的 active 會員文件。確認另一位老師看不到第一位老師的學生、收款與預約。開兩個獨立瀏覽器設定檔用同一 UID 測試同步及衝突。

官方文件可查閱 [Firebase Auth 模擬器](https://firebase.google.com/docs/emulator-suite/connect_auth)、[Security Rules 模擬測試](https://firebase.google.com/docs/firestore/security/test-rules-emulator) 與 [Firestore 交易](https://firebase.google.com/docs/firestore/manage-data/transactions)。

權限測試涵蓋信箱驗證、帳號核准、阻止刪除中的帳號重新啟用、封鎖舊空堂根集合及允許讀取指定老師的空堂文件。既有 Email 管理員設定密碼後應沿用原 UID 與管理員角色。

## 正式部署前檢查

1. 舊版在每個有真實資料的瀏覽器先使用「匯出 JSON」。確認檔案可讀，留存學生、課程、教學紀錄、已收款堂數及空堂設定的基準。確認資料所在的瀏覽器來源與正式網址。
2. 由有權限的 Firebase 擁有人以 Cloud Firestore 匯出保存正式資料，涵蓋 `publicAvailability` 及 Worker 依賴的集合。保留文件 ID、欄位型別與原作業規則，先在隔離的環境核對還原流程。保存正式部署的 Git SHA、現行 Firebase Auth Provider 設定和 LINE 設定。Firestore 管理匯出存取權及計費參見 [匯出與匯入資料](https://firebase.google.com/docs/firestore/manage-data/export-import)。
3. 在 Firebase Console 啟用 Authentication 的「電子郵件／密碼」並確認授權網域含 `naco727.github.io`。在 Authentication 的郵件範本確認信箱驗證和重設密碼使用可用的 Firebase 動作頁。參見 [Firebase 密碼登入](https://firebase.google.com/docs/auth/web/password-auth)。
4. 使用既有管理員的信箱設定密碼並完成登入，核對原 UID 及 `memberships/{uid}` 的 `role: "admin"`、`status: "active"`。若原帳號只有手機號碼，請由 Firebase 專案管理者先將信箱加到同一個 Auth UID，再用該信箱設定密碼並驗證。參見 [Firebase Admin 使用者管理](https://firebase.google.com/docs/auth/admin/manage-users#update_a_user)。
5. 完成測試、取得批准後，先對照正式 Firestore Rules，把 `firestore.rules` 合併與核對後再發布至正式 `(default)`。依原設定保留相關已部署索引，另外將 `chunks.payload` 設為不索引。待正式 Rules、索引及角色確認後，才合併分支並由 GitHub Pages 從已驗證的分支部署。正式讀取或寫入需驗證 [Firebase 官方規則部署步驟](https://firebase.google.com/docs/firestore/security/get-started)。
6. 先將正式 Worker 切換至下方的老師文件並驗收「詢問時段」。接著發布新版 Firestore Rules，核對舊根集合已無法從客戶端讀取，最後在完成備份並確認刪除後，從 Firebase Console 移除根集合 `publicAvailability`。

若日後支援多個 LINE Bot，可為各 Worker 環境配置不同的 `TEACHER_UID`，或以可信任的 LINE Channel 對應表選定 UID。

## 電子郵件與密碼登入

1. 輸入電子郵件和密碼後選「申請帳號」。Firebase 會拒絕重複註冊。新帳號點開驗證信後，回到 TutorFlow 按「重新檢查」，等待管理員核准。
2. 選「登入」時由 Firebase 檢查帳號密碼。在信箱列舉保護開啟時，未知帳號和密碼錯誤會顯示同一則提示。參見 [Firebase 信箱列舉保護](https://docs.cloud.google.com/identity-platform/docs/admin/email-enumeration-protection)。
3. 曾使用連結登入的帳號，輸入原信箱並選「設定或重設密碼」。設定後以同一信箱登入，原 Firebase UID 和會員角色繼續沿用。

## LINE Bot 及公開空堂切換

1. 備份 `turtorflow/(default)` 中完整的 `publicAvailability` 集合。以 Firestore REST `listDocuments` 保存所有分頁的 `documents` 陣列及原文件名稱。保留原 Firestore Value 形式的 `fields`，如 `stringValue`、`mapValue` 或 `arrayValue`，不要先轉成一般 JavaScript 型別。
2. 執行 `node scripts/availability-migration.cjs prepare 舊資料備份.json 正式老師UID 審核用目標.json`。這個工具只從本機備份產生新檔。目標是一份包含 `slots` 的文件，每個陣列元素原樣保留一份舊文件的 `fields`。舊文件 ID 仍留在來源及備份。先確認文件內容全可公開，並確認目標目前不存在。
3. 正式確認後，使用具備權限的 Firestore 管理工具建立新文件。若透過 API，使用 `createDocument`，讓目標已存在時報錯。讀回目標的 Firestore REST Document，執行 `node scripts/availability-migration.cjs verify 舊資料備份.json 正式老師UID 讀回目標.json`，核對 UID 路徑、陣列順序、所有欄位及型別。
4. 若 Worker 還在列出根集合，匯出目前完整 Worker 為 `old-worker.mjs`，在專案根目錄執行 `node worker/apply-availability-change.cjs old-worker.mjs updated-worker.mjs`。補丁只更新空堂讀取與對應的呼叫。核對圖文選單、Quick Reply、Flex 及預約訊息流程，沿用目前 LINE 相關 Secrets。
5. 在 Cloudflare Worker 的「Settings → Variables and Secrets」加入文字環境變數 `TEACHER_UID`，值為 `Gt8LnIg2RHNLIdVIYGiI5YomyWK2`。Worker 會直接以 REST GET 讀取 `teachers/{TEACHER_UID}/public/publicAvailability`，並解析 `slots`。專案與資料庫預設為 `turtorflow` 與 `(default)`。公開讀取無需 Firebase 私密金鑰。切換後保持原 Webhook URL，從 LINE 聊天室點「詢問時段」，核對顯示及預約連結。舊公開網頁也已設定讀取相同老師的文件。參見 [Cloudflare Workers 環境變數](https://developers.cloudflare.com/workers/configuration/environment-variables/)。
6. 若需要回復，使用保存的原 Worker 版本和舊集合。原文件在切換期間保留，注意並人工核對切換後新文件上的變更，避免復原到過期空堂。任何正式資料回寫或重啟舊寫入須先獲批准。

## 啟用老師帳號管理服務

「資料管理 → 老師管理」會顯示 Firebase Auth 已驗證的信箱。管理員確認刪除後，服務會鎖定指定老師，再刪除 Firebase Auth 帳號、會員資料、工作區分塊和公開空堂。工作區包含學生、課程、教學紀錄、收費與設定。瀏覽器裡的草稿及離線 JSON 備份仍留在原裝置。Firestore 只保留無信箱內容的 UID 停用標記，避免舊登入狀態重新建立會員資料。

1. 在測試 Firebase 專案發布本版 Firestore Rules。驗證管理員能看見申請人信箱、一般老師無法存取管理服務，並使用測試帳號驗證刪除。正式啟用前，先比對正在運作的 Firestore 規則，再發布本版規則。
2. 為帳號管理建立專用 Google Cloud 服務帳號。自訂 IAM 角色所需權限為 `firebaseauth.users.get`、`firebaseauth.users.delete`、`datastore.databases.get`、`datastore.entities.get`、`datastore.entities.list`、`datastore.entities.create`、`datastore.entities.update`、`datastore.entities.delete`。將角色授予此服務帳號。參見 [Firestore IAM](https://docs.cloud.google.com/firestore/native/docs/security/iam) 與 [Firebase 帳號刪除 API](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/delete)。
3. 建立獨立的 Cloudflare Worker，部署 `worker/account-admin.mjs`。在 Worker Settings 的 Secrets 保存專用服務帳號的完整 JSON 金鑰，名稱為 `FIREBASE_ACCOUNT_ADMIN_SERVICE_ACCOUNT`。專案預設為 `turtorflow`，測試時可用 `FIREBASE_PROJECT_ID` 指定另一個專案。預設只接受 `https://naco727.github.io` 的瀏覽器請求。若測試來源網域不同，在測試 Worker 設定 `TUTORFLOW_ADMIN_ORIGIN`。LINE Bot 繼續使用既有 Worker。
4. 將管理 Worker 的 HTTPS 網址填入 `firebase-config.js` 的 `TUTORFLOW_ACCOUNT_ADMIN_URL` 後部署網站。管理服務的認證使用已登入的 Firebase ID Token，並查核有效的管理員角色。JSON 金鑰僅保存在 Worker Secret。
5. 在「老師管理」載入帳號列表。如果刪除中斷，可用「繼續刪除」完成清理。刪除對象限一般老師帳號。

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
