# TutorFlow LINE LIFF 公開空堂設定

此檔保留原有 LIFF 設定以供相容查閱。多老師升級的正式空堂查詢由 LINE Bot 直接讀取 Firestore。

## LIFF ID 設定位置

LIFF ID 放在：

```text
firebase-config.js
```

目前設定為：

```js
window.TUTORFLOW_LIFF_ID = '2012741223-NOSRPMAp';
```

LIFF ID 與 Firebase Web config 都是前端公開設定，不是 Admin 私密金鑰。

## LINE Developers 設定

在 LINE Developers Console → Provider → LIFF App：

1. 開啟目前的 LIFF App。
2. Endpoint URL 設為：

   ```text
   https://naco727.github.io/tutorflow/?mode=public
   ```

3. Scope 不需要開啟 `profile` 或 `email`；TutorFlow 不會要求家長登入 LINE，也不會讀取家長個人資料。
4. 保留 HTTPS，並確認 LIFF App 狀態可用。

LIFF 頁面會執行 `liff.init({ liffId })`。在 LINE App 內建瀏覽器會顯示 LINE 模式，在一般瀏覽器會顯示一般公開模式；兩種情況都不會自動呼叫 `liff.login()`。

## 官方帳號圖文選單

在 LINE Official Account Manager → 圖文選單：

1. 建立或編輯圖文選單。
2. 選擇動作類型「網址」。
3. URL 填入 LIFF URL：

   ```text
   https://liff.line.me/2012741223-NOSRPMAp
   ```

4. 儲存並發布圖文選單。

家長點擊後會先進入 LIFF，再載入 `?mode=public` 公開頁面。公開頁面只讀取 Firestore `publicAvailability` 的日期、起訖時間與狀態，不會載入 TutorFlow 管理端的學生、課程、教學紀錄或財務資料。

## 讀取失敗行為

公開頁面不再使用 localStorage 的公開快取作為最新資料。Firestore 讀取失敗時會顯示維護提示，不會把過期本機空堂當成最新資料。

空堂計算結果若為 30 分鐘或更短，不會出現在公開空堂，也不會上傳至 Firestore。

## 測試

1. 一般瀏覽器開啟：

   ```text
   https://naco727.github.io/tutorflow/?mode=public
   ```

2. LINE App 內開啟：

   ```text
   https://liff.line.me/2012741223-NOSRPMAp
   ```

3. 確認頁面顯示最新 Firestore 空堂。
4. 暫時停止網路或模擬 Firestore 讀取失敗，確認頁面顯示維護提示且沒有顯示本機舊資料。
