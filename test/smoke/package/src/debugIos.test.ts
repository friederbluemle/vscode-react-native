// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as assert from "assert";
import { AppiumHelper, AppiumClient, Platform } from "./helpers/appiumHelper";
import { SmokeTestsConstants } from "./helpers/smokeTestsConstants";
import { RNworkspacePath, runVSCode, ExpoWorkspacePath, pureRNWorkspacePath } from "./main";
import { IosSimulatorHelper } from "./helpers/iosSimulatorHelper";
import { sleep, findFile, findExpoURLInLogFile, findExpoSuccessAndFailurePatterns, ExpoLaunch, getIOSBuildPath, waitForRunningPackager } from "./helpers/utilities";
import { SetupEnvironmentHelper } from "./helpers/setupEnvironmentHelper";
import * as path from "path";
import { TestRunArguments } from "./helpers/configHelper";
import { Application } from "../../automation";

const RnAppBundleId = "org.reactjs.native.example.latestRNApp";
const RNDebugConfigName = "Debug iOS";
const ExpoDebugConfigName = "Debug in Exponent";
const ExpoLanDebugConfigName = "Debug in Exponent (LAN)";
const ExpoLocalDebugConfigName = "Debug in Exponent (Local)";
const STOP_PACKAGER_COMMAND = "React Native: Stop Packager";

const RNSetBreakpointOnLine = 1;
const ExpoSetBreakpointOnLine = 1;
// Time for OS Debug Test before it reaches timeout
const debugIosTestTime = SmokeTestsConstants.iosAppBuildAndInstallTimeout + 100 * 1000;
// Time for iOS Expo Debug Test before it reaches timeout
const debugExpoTestTime = SmokeTestsConstants.expoAppBuildAndInstallTimeout + 400 * 1000;

let expoFirstLaunch = true;

export function setup(testParameters?: TestRunArguments) {
    describe("Debugging iOS", () => {
        let app: Application;
        let clientInited: AppiumClient;

        afterEach(async () => {
            if (app) {
                await app.stop();
            }
            if (clientInited) {
                clientInited.closeApp();
                clientInited.endAll();
            }
        });

        async function runExpoDebugScenario(logFilePath: string, testName: string, workspacePath: string, debugConfigName: string, triesToLaunchApp: number) {
            console.log(`${testName}: Starting debugging`);
            // Scan logs only if launch retries provided (Expo Tunnel scenarios)
            if (triesToLaunchApp <= 1) {
                await app.workbench.quickaccess.runDebugScenario(debugConfigName);
            } else {
                for (let retry = 1; retry <= triesToLaunchApp; retry++) {
                    let expoLaunchStatus: ExpoLaunch;
                    await app.workbench.quickaccess.runDebugScenario(debugConfigName);
                    expoLaunchStatus = await findExpoSuccessAndFailurePatterns(logFilePath, SmokeTestsConstants.ExpoSuccessPattern, SmokeTestsConstants.ExpoFailurePattern);
                    if (expoLaunchStatus.successful) {
                        break;
                    } else {
                        if (retry === triesToLaunchApp) {
                            assert.fail(`App start has failed after ${retry} retries`);
                        }
                        console.log(`Attempt to start #${retry} failed, retrying...`);
                    }
                }
            }
        }

        async function expoTest(appFileName: string, testName: string, workspacePath: string, debugConfigName: string, triesToLaunchApp: number, isPureExpo: boolean = false) {
            let logFilePath = "";
            app = await runVSCode(workspacePath);
            console.log(`${testName}: ${workspacePath} directory is opened in VS Code`);
            await app.workbench.quickaccess.openFile(appFileName);
            await app.workbench.editors.scrollTop();
            console.log(`${testName}: ${appFileName} file is opened`);
            await app.workbench.debug.setBreakpointOnLine(ExpoSetBreakpointOnLine);
            console.log(`${testName}: Breakpoint is set on line ${ExpoSetBreakpointOnLine}`);
            console.log(`${testName}: Chosen debug configuration: ${debugConfigName}`);
            const device = <string>IosSimulatorHelper.getDevice();
            if (process.env.REACT_NATIVE_TOOLS_LOGS_DIR) {
                logFilePath = path.join(process.env.REACT_NATIVE_TOOLS_LOGS_DIR, SmokeTestsConstants.ReactNativeLogFileName);
            } else {
                assert.fail("REACT_NATIVE_TOOLS_LOGS_DIR is not defined");
            }
            await runExpoDebugScenario(logFilePath, testName, workspacePath, debugConfigName, triesToLaunchApp);
            // We stop and start Pure Expo debug scenario again, since we faced Metro cache processing problem on
            // Expo SDK 38. The debug scenario works fine only on the second and further launches of the packager.
            // As soon as this problem is fixed, this condition won't be needed.
            if (isPureExpo) {
                await waitForRunningPackager(logFilePath);
                await app.workbench.debug.stopDebugging();
                await app.workbench.quickaccess.runCommand(STOP_PACKAGER_COMMAND);
                await sleep(2 * 1000);
                await runExpoDebugScenario(logFilePath, testName, workspacePath, debugConfigName, triesToLaunchApp);
            }

            await app.workbench.editors.waitForTab("Expo QR Code readonly");
            await app.workbench.editors.waitForActiveTab("Expo QR Code readonly");
            console.log(`${testName}: 'Expo QR Code' tab found`);

            let expoURL;
            if (process.env.REACT_NATIVE_TOOLS_LOGS_DIR) {
                expoURL = findExpoURLInLogFile(path.join(process.env.REACT_NATIVE_TOOLS_LOGS_DIR, SmokeTestsConstants.ReactNativeRunExpoLogFileName));
            }

            assert.notStrictEqual(expoURL, null, "Expo URL pattern is not found");
            expoURL = expoURL as string;
            let appFile = findFile(SetupEnvironmentHelper.iOSExpoAppsCacheDir, /.*\.(app)/);
            if (!appFile) {
                throw new Error(`iOS Expo app is not found in ${SetupEnvironmentHelper.iOSExpoAppsCacheDir}`);
            }
            const appPath = path.join(SetupEnvironmentHelper.iOSExpoAppsCacheDir, appFile);
            const opts = AppiumHelper.prepareAttachOptsForIosApp(device, appPath);
            let client = AppiumHelper.webdriverAttach(opts);
            clientInited = client.init();
            await AppiumHelper.openExpoApplication(Platform.iOS, clientInited, expoURL, workspacePath, expoFirstLaunch);
            expoFirstLaunch = false;
            console.log(`${testName}: Waiting ${SmokeTestsConstants.expoAppBuildAndInstallTimeout}ms until Expo app is ready...`);
            await sleep(SmokeTestsConstants.expoAppBuildAndInstallTimeout);

            await AppiumHelper.disableExpoErrorRedBox(clientInited);
            await AppiumHelper.disableDevMenuInformationalMsg(clientInited, Platform.iOSExpo);
            await AppiumHelper.enableRemoteDebugJS(clientInited, Platform.iOSExpo);
            await sleep(5 * 1000);

            await app.workbench.debug.waitForDebuggingToStart();
            console.log(`${testName}: Debugging started`);
            await app.workbench.debug.waitForStackFrame(sf => sf.name === appFileName && sf.lineNumber === ExpoSetBreakpointOnLine, `looking for ${appFileName} and line ${ExpoSetBreakpointOnLine}`);
            console.log(`${testName}: Stack frame found`);
            await app.workbench.debug.stepOver();
            // Wait for our debug string to render in debug console
            await sleep(SmokeTestsConstants.debugConsoleSearchTimeout);
            console.log(`${testName}: Searching for \"Test output from debuggee\" string in console`);
            let found = await app.workbench.debug.waitForOutput(output => output.some(line => line.indexOf("Test output from debuggee") >= 0));
            assert.notStrictEqual(found, false, "\"Test output from debuggee\" string is missing in debug console");
            console.log(`${testName}: \"Test output from debuggee\" string is found`);
            await app.workbench.debug.stopDebugging();
            console.log(`${testName}: Debugging is stopped`);
        }

        it("RN app Debug test", async function () {
            this.timeout(debugIosTestTime);
            app = await runVSCode(RNworkspacePath);
            await app.workbench.quickaccess.openFile("App.js");
            await app.workbench.editors.scrollTop();
            console.log("iOS Debug test: App.js file is opened");
            await app.workbench.debug.setBreakpointOnLine(RNSetBreakpointOnLine);
            console.log(`iOS Debug test: Breakpoint is set on line ${RNSetBreakpointOnLine}`);
            console.log(`iOS Debug test: Chosen debug configuration: ${RNDebugConfigName}`);
            // We need to implicitly add target to "Debug iOS" configuration to avoid running additional simulator
            SetupEnvironmentHelper.addIosTargetToLaunchJson(RNworkspacePath);
            console.log("iOS Debug test: Starting debugging");
            await app.workbench.quickaccess.runDebugScenario(RNDebugConfigName);

            await IosSimulatorHelper.waitUntilIosAppIsInstalled(RnAppBundleId, SmokeTestsConstants.iosAppBuildAndInstallTimeout, 40 * 1000);
            const device = <string>IosSimulatorHelper.getDevice();
            const buildPath = getIOSBuildPath(
                `${RNworkspacePath}/ios`,
                `${SmokeTestsConstants.RNAppName}.xcworkspace`,
                "Debug",
                SmokeTestsConstants.RNAppName,
                "iphonesimulator"
            );
            const appPath = `${buildPath}/${SmokeTestsConstants.RNAppName}.app`;
            const opts = AppiumHelper.prepareAttachOptsForIosApp(device, appPath);
            let client = AppiumHelper.webdriverAttach(opts);
            clientInited = client.init();
            await AppiumHelper.enableRemoteDebugJS(clientInited, Platform.iOS);
            await sleep(5 * 1000);

            await app.workbench.debug.waitForDebuggingToStart();
            console.log("iOS Debug test: Debugging started");
            await app.workbench.debug.waitForStackFrame(sf => sf.name === "App.js" && sf.lineNumber === RNSetBreakpointOnLine, `looking for App.js and line ${RNSetBreakpointOnLine}`);
            console.log("iOS Debug test: Stack frame found");
            await app.workbench.debug.stepOver();
            // Wait for our debug string to render in debug console
            await sleep(SmokeTestsConstants.debugConsoleSearchTimeout);
            console.log("iOS Debug test: Searching for \"Test output from debuggee\" string in console");
            let found = await app.workbench.debug.waitForOutput(output => output.some(line => line.indexOf("Test output from debuggee") >= 0));
            assert.notStrictEqual(found, false, "\"Test output from debuggee\" string is missing in debug console");
            console.log("iOS Debug test: \"Test output from debuggee\" string is found");
            await app.workbench.debug.stopDebugging();
            console.log("iOS Debug test: Debugging is stopped");
        });

        it("Expo app Debug test(Tunnel)", async function () {
            if (testParameters && testParameters.RunBasicTests) {
                this.skip();
            }
            this.timeout(debugExpoTestTime);
            await expoTest("App.tsx", "iOS Expo Debug test(Tunnel)", ExpoWorkspacePath, ExpoDebugConfigName, 5);
        });

        it("Pure RN app Expo test(LAN)", async function () {
            if (testParameters && testParameters.RunBasicTests) {
                this.skip();
            }
            this.timeout(debugExpoTestTime);
            await expoTest("App.js", "iOS pure RN Expo test(LAN)", pureRNWorkspacePath, ExpoLanDebugConfigName, 1, true);
        });

        it("Expo app Debug test(LAN)", async function () {
            if (testParameters && testParameters.RunBasicTests) {
                this.skip();
            }
            this.timeout(debugExpoTestTime);
            await expoTest("App.tsx", "iOS Expo Debug test(LAN)", ExpoWorkspacePath, ExpoLanDebugConfigName, 1);
        });

        it("Expo app Debug test(localhost)", async function () {
            if (testParameters && testParameters.RunBasicTests) {
                this.skip();
            }
            this.timeout(debugExpoTestTime);
            await expoTest("App.tsx", "iOS Expo Debug test(localhost)", ExpoWorkspacePath, ExpoLocalDebugConfigName, 1);
        });
    });
}
