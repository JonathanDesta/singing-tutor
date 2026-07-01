/**
 * Firebase web app config. These values are PUBLIC identifiers (safe to
 * commit — security comes from Firestore rules + Auth, not from hiding
 * them). Empty apiKey = sync disabled, app runs local-only.
 *
 * Fill in from: Firebase console → Project settings → Your apps → Web app.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyDlVDpGRAd1PRi3eTRXvKsMP30Z3YFjppY",
  authDomain: "desta-singing.firebaseapp.com",
  projectId: "desta-singing",
  storageBucket: "desta-singing.firebasestorage.app",
  messagingSenderId: "680566276214",
  appId: "1:680566276214:web:10f1c98b4c7a5a86321f57",
};

export const firebaseEnabled = firebaseConfig.apiKey !== "";
