# TutorFlow Firebase Phone Auth 設定

本分支保留 TutorFlow 原本的 `localStorage` JSON 作為主要資料來源，Firebase 只負責老師登入，以及公開空堂的 `publicAvailability` 集合。學生、聯絡方式、課程紀錄、費率與付款資料不會上傳 Firestore。

## 1. 在 `index.html` 設定 Web config 與老師 UID

在 Firebase Console 的 Project settings → Your apps → Web app 取得 Firebase Web config，並在 `index.html` 的 Firebase 設定註解之後、`const FIREBASE_CONFIG` 之前加入：

```html
<script>
  window.TUTORFLOW_FIREBASE_CONFIG = {
    apiKey: 'Firebase Web config 的 apiKey',
    authDomain: '你的專案.firebaseapp.com',
    projectId: '你的專案 projectId',
    appId: 'Firebase Web config 的 appId'
  };
  window.TUTORFLOW_AUTHORIZED_TEACHER_UIDS = [
    'Firebase Authentication 使用者的 UID'
  ];
</script>
```

若維持目前的單一 HTML 結構，也可以直接把這兩個 `window` 設定放在同一個 `<script>` 的常數宣告前。Web config 與 UID 不是 Admin 私密金鑰；不要放入 service account、Admin SDK private key 或任何私密憑證。

UID 取得方式：Firebase Console → Authentication → Users，找到老師的手機帳號，複製 UID。授權依 UID 判斷，不依電話號碼判斷。

## 2. Firebase Console 手動設定

1. Authentication → Sign-in method：啟用 Phone。
2. Authentication → Settings → Authorized domains：加入 `naco727.github.io`；本機測試時視需要加入 `localhost`。
3. Authentication → Sign-in method → Phone numbers for testing：只在測試環境設定測試手機與固定驗證碼。程式不會硬編碼測試號碼或驗證碼。
4. Firestore Database → Rules：貼上下面完整規則，並把 `REPLACE_WITH_TEACHER_UID` 替換成實際老師 UID。

## 3. Firestore Security Rules

```text
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    function isAuthorizedTeacher() {
      return request.auth != null
        && request.auth.uid in ['REPLACE_WITH_TEACHER_UID'];
    }

    function isValidPublicSlot() {
      return request.resource.data.keys().hasOnly([
          'date', 'start', 'end', 'status'
        ])
        && request.resource.data.date is string
        && request.resource.data.start is string
        && request.resource.data.end is string
        && request.resource.data.status == 'available';
    }

    match /publicAvailability/{slotId} {
      allow read: if true;
      allow create, update: if isAuthorizedTeacher()
        && isValidPublicSlot();
      allow delete: if isAuthorizedTeacher();
    }

    // 不讓前端意外讀寫其他集合。
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

公開端只能讀取日期、起訖時間與 `available` 狀態；只有規則中的老師 UID 可以新增、修改或刪除公開空堂。Rules 是真正的權限邊界，前端 UID 清單只是使用者體驗與 UI gate，不能取代 Rules。

## 4. 測試流程

1. 在 Firebase Console 設定測試手機號碼與固定驗證碼。
2. 在 `index.html` 填入 Web config 與老師 UID。
3. 用 `https://naco727.github.io/tutorflow/` 開啟，或使用本機 HTTP server（不要用不支援 Firebase 驗證的任意檔案預覽方式）。
4. 輸入測試手機號碼，完成 reCAPTCHA，按「發送驗證碼」。
5. 輸入 Firebase Console 設定的六位數測試碼，確認進入 TutorFlow。
6. 用未列入 UID 的 Firebase 帳號測試，應被拒絕並返回登入頁。
7. 在設定頁計算空堂，再按「同步空堂」；確認 Firestore 只有 `publicAvailability` 公開欄位。
8. 用 `https://naco727.github.io/tutorflow/?mode=public` 測試，確認不需要登入且只顯示公開空堂。
9. 測試登出後返回登入頁，重新整理確認 Firebase 持續登入；確認 localStorage 的 `tutorflow-data-v1` 沒有被清除。

## 5. GitHub Pages 部署

```bash
git switch feature/firebase-phone-auth
git add index.html tutorflow-icon.jpg FIREBASE_SETUP.md
git commit -m "加入 Firebase 手機驗證登入"
git push -u origin feature/firebase-phone-auth
```

確認設定與測試完成後，再以 Pull Request 合併到 `main`。GitHub Pages 需從 `main`（或專案目前指定的 Pages branch）部署；Firebase Authorized domains 必須包含實際 Pages 網域。

## 已知限制與安全提醒

- Firebase Web config 可以出現在前端，但不能放 Admin SDK 憑證。
- reCAPTCHA 會在瀏覽器中執行，正式環境不可停用應用程式驗證。
- Firebase Authentication 登入不會加密既有 localStorage；學生資料仍是該瀏覽器可讀的本機資料，請定期匯出並保護裝置。
- Firestore 同步失敗時，課程與空堂仍保留在本機；公開頁面會顯示最後一次成功同步的雲端空堂。
- `publicAvailability` 規則目前只驗證必要欄位與 `available` 狀態，日期起訖的業務正確性仍由管理介面計算與驗證。
