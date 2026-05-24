module.exports = {
  preset: 'react-native',
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|expo|@expo|@react-navigation|react-native-gesture-handler)/)',
  ],
  setupFilesAfterEnv: [],
};
