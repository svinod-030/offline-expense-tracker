import "./global.css";
import React, { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Alert, Platform, DeviceEventEmitter, PermissionsAndroid } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useColorScheme } from "nativewind";
import { initDatabase } from "./src/db/database";
import { useExpenseStore } from "./src/store/useExpenseStore";
import { checkSmsPermission, requestSmsPermissionWithStatus } from "./src/utils/smsReader";
import { loadCachedConfig, refreshRemoteConfig } from "./src/utils/remoteConfig";
import UpdateModal from './src/components/UpdateModal';
import { checkVersion } from './src/utils/versionCheckService';
import { VersionCheckResult } from './src/types';
import RootNavigator, { darkTheme, lightTheme } from "./src/navigation/RootNavigator";
import { NavigationContainer } from "@react-navigation/native";
import { AnimatedSplashScreen } from "./src/components/common/AnimatedSplashScreen";
import SyncProgressModal from './src/components/SyncProgressModal';


export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [animationFinished, setAnimationFinished] = useState(false);
  const [initialSyncDone, setInitialSyncDone] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<VersionCheckResult | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === "dark";

  const syncProgress = useExpenseStore(state => state.syncProgress);

  // 1. Core initialization sequence
  useEffect(() => {
    async function setup() {
      try {
        // a. DB and Config Init
        await Promise.all([
          initDatabase(),
          loadCachedConfig()
        ]);
        setIsReady(true);

        // b. Silent pre-loads
        refreshRemoteConfig().catch(() => { /* non-fatal background refresh */ });

        // c. Check for updates
        if (!__DEV__) {
          checkVersion().then(result => {
            if (result.isUpdateAvailable) {
              setUpdateInfo(result);
              setShowUpdateModal(true);
            }
          }).catch(() => { });
        }

        // d. Post-launch notification permission (Android 13+)
        if (Platform.OS === "android" && Platform.Version >= 33) {
          PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
            {
              title: "Enable Transaction Notifications",
              message: "SpendWise will send you a notification whenever a transaction is detected in an incoming SMS.",
              buttonPositive: "Allow",
              buttonNegative: "Not Now",
            }
          ).catch(() => { });
        }
      } catch (error) {
        console.error("Failed to initialize app:", error);
      }
    }
    setup();
  }, []);

  // 2. Initial SMS Import logic (gated by isReady)
  useEffect(() => {
    async function runLaunchImport() {
      if (!isReady || initialSyncDone) return;

      const store = useExpenseStore.getState();

      if (Platform.OS === "android") {
        const hasPermission = await checkSmsPermission();
        if (!hasPermission) {
          Alert.alert(
            "Allow SMS permission",
            "Enable SMS access to automatically import transactions from your bank and UPI messages.",
            [
              { text: "Not now", onPress: () => setInitialSyncDone(true), style: "cancel" },
              {
                text: "Grant Permission",
                onPress: async () => {
                  const status = await requestSmsPermissionWithStatus();
                  if (status === "granted") {
                    await store.runInitialSmsImportIfNeeded();
                  }
                  setInitialSyncDone(true);
                },
              },
            ]
          );
          return;
        }
        await store.runInitialSmsImportIfNeeded();
        await store.fetchBills();
      }
      setInitialSyncDone(true);
    }
    runLaunchImport();
  }, [isReady, initialSyncDone]);

  // 3. Real-time SMS sync (gated by initialSyncDone)
  useEffect(() => {
    if (!isReady || !initialSyncDone || Platform.OS !== "android") return;

    const store = useExpenseStore.getState();

    const runSync = async () => {
      try {
        await store.syncRecentSmsTransactions();
      } catch (err) {
        console.error("Sync failed:", err);
      }
    };

    // Real-time Refresh listener
    const subscription = DeviceEventEmitter.addListener("onSmsReceived", () => {
      setTimeout(() => {
        store.fetchTransactions();
        store.fetchBills();
      }, 2000);
    });

    // Run sync once initial import is confirmed done
    runSync();

    return () => {
      subscription.remove();
    };
  }, [isReady, initialSyncDone]);

  if (!animationFinished) {
    return <AnimatedSplashScreen onAnimationComplete={() => setAnimationFinished(true)} />;
  }

  return (
    <NavigationContainer theme={isDark ? darkTheme : lightTheme}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <RootNavigator />
          <StatusBar style={isDark ? "light" : "dark"} />
          {updateInfo && (
            <UpdateModal
              visible={showUpdateModal}
              onClose={() => setShowUpdateModal(false)}
              latestVersion={updateInfo.latestVersion}
              storeUrl={updateInfo.storeUrl}
            />
          )}
          {syncProgress && (
            <SyncProgressModal
              visible={!!syncProgress}
              current={syncProgress.current}
              total={syncProgress.total}
              message={syncProgress.message}
            />
          )}
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </NavigationContainer>
  );
}
