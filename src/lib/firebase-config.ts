/**
 * Firebase web app config. These values are PUBLIC identifiers (safe to
 * commit — security comes from Firestore rules + Auth, not from hiding
 * them). Empty apiKey = sync disabled, app runs local-only.
 *
 * Fill in from: Firebase console → Project settings → Your apps → Web app.
 */
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

export const firebaseEnabled = firebaseConfig.apiKey !== "";
