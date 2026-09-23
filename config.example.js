// Firebase Realtime Database, project kitchen-table-magic, Singapore region.
// None of this is a secret. Access is controlled by the database rules, which
// only let one signed-in Google account read or write /tables and /decks.
// Leave apiKey and googleClientId out to sync with no sign-in at all.
window.MTG_FIREBASE = {
  databaseURL: "https://kitchen-table-magic-default-rtdb.asia-southeast1.firebasedatabase.app",
  apiKey: "<Firebase web API key>",
  googleClientId: "<OAuth web client id>.apps.googleusercontent.com"
};
