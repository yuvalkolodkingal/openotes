/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import type { Page } from "@playwright/test";
import { downloadAndReadFile, getTestId, uploadFile } from "../utils";
import { fillConfirmPasswordDialog, fillPasswordDialog } from "./utils";
import { NavigationMenuModel } from "./navigation-menu.model";

export class SettingsViewModel {
  private readonly page: Page;
  private readonly navigation: NavigationMenuModel;

  constructor(page: Page) {
    this.page = page;
    this.navigation = new NavigationMenuModel(page, "settings-navigation-menu");
  }

  async close() {
    await this.page.locator(getTestId("settings-search")).focus();
    await this.page.waitForTimeout(100);
    await this.page.keyboard.press("Escape");
    await this.page.waitForTimeout(1000);
  }

  async createBackup() {
    const item = await this.navigation.findItem("Backup & export");
    await item?.click();

    const saveBackup = async () => {
      const backupData = this.page
        .locator(getTestId("setting-create-backup"))
        .locator("select");
      await backupData.selectOption({ value: "partial", label: "Backup" });
    };

    return await downloadAndReadFile(this.page, saveBackup, "utf-8");
  }

  async restoreData(filename: string, password?: string) {
    const item = await this.navigation.findItem("Backup & export");
    await item?.click();

    const restoreBackup = this.page
      .locator(getTestId("setting-restore-backup"))
      .locator("button");

    await uploadFile(this.page, restoreBackup, filename);
    if (password) await fillPasswordDialog(this.page, password);
  }

  async selectImageCompression(option: { value: string; label: string }) {
    const item = await this.navigation.findItem("Behaviour");
    await item?.click();

    const imageCompressionDropdown = this.page
      .locator(getTestId("setting-image-compression"))
      .locator("select");

    await imageCompressionDropdown.selectOption(option);
  }

  async enableAppLock(appLockPassword: string) {
    const item = await this.navigation.findItem("App lock");
    await item?.click();

    const appLockSwitch = this.page
      .locator(getTestId("setting-enable-app-lock"))
      .locator("label");

    await appLockSwitch.click();
    await this.page.waitForTimeout(500);
    await fillConfirmPasswordDialog(this.page, appLockPassword);
    await this.page.waitForTimeout(500);
  }

  async disableAppLock(appLockPassword: string) {
    const item = await this.navigation.findItem("App lock");
    await item?.click();

    const appLockSwitch = this.page
      .locator(getTestId("setting-enable-app-lock"))
      .locator("label");

    await appLockSwitch.click();
    await fillPasswordDialog(this.page, appLockPassword);
    await this.page.waitForTimeout(100);
  }

  async setTitleFormat(format: string) {
    const item = await this.navigation.findItem("Editor");
    await item?.click();

    const titleFormatInput = this.page
      .locator(getTestId("setting-default-title"))
      .locator("input");
    await titleFormatInput.fill(format);
  }

  async checkForUpdates() {
    await this.navigation.waitFor();

    const item = await this.navigation.findItem("About");
    await item?.click();

    const button = this.page
      .locator(getTestId("setting-version"))
      .locator("button", { hasText: "Check for updates" });
    await button.click();
  }
}
