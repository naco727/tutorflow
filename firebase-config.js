// Firebase Web config 可放在前端；請勿放入 Firebase Admin SDK 私密金鑰。
// 老師 UID 請填入 Firebase Authentication 使用者的 UID，不要填電話號碼。
window.TUTORFLOW_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDE4IWus705zHS6QHb9RmMOiQnZYGj2Y14',
  authDomain: 'turtorflow.firebaseapp.com',
  projectId: 'turtorflow',
  storageBucket: 'turtorflow.firebasestorage.app',
  messagingSenderId: '587503632857',
  appId: '1:587503632857:web:baa88d16c9012717da19c8',
  measurementId: 'G-Z7E6HQ1YPL'
};

// 請在 Firebase Console → Authentication → Users 複製老師 UID 後填入。
// 未填入前，所有管理者登入都會被拒絕，公開空堂頁面仍可使用。
window.TUTORFLOW_AUTHORIZED_TEACHER_UIDS = [
  'a8HEV8D9IkdAVxu2z3KssWCk0oc2'
];
