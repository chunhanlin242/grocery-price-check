# Handoff：手機介面大改版 + 資料品質修正

**文件放這裡**：C:\Users\U9\Desktop\Claude小工具\price-check\docs\handoff\2026-10-19-mobile-ui-overhaul.md
**路徑基準**：程式碼在 C:\Users\U9\Desktop\Claude小工具\price-check，本文件內所有相對路徑都以那裡為準

類型：continuation（程式都已上線，剩真機驗收與文件同步）

## 狀態摘要

三筆 commit 都已部署並 push 到 private repo（最新 `07673b3`，Worker 版本 `6dce14bd`，SW `v13`）：

- `8bccf1d` iPhone／安卓一致化（SVG 導覽圖示、48px 點擊區、解除放大鎖）、首頁照「最近碰過」排序（新同步表 `item_views`）、店家頁就地展開
- `649fce4` 第一性原理檢查後的修正：店家展開後「在這裡順手拍」、單位跟著標籤走（`reconcileUnit`）、「舊」分一般 90 天／促銷 14 天
- `07673b3` 單手好用改版：所有按鈕移到底部（`sheet-foot`、`menuSheet`、店家切換列在底部）、記價先選方式再給確認卡、介面只留中文、單品排行跨組合併
- 正式 D1 資料已修：蛋／蘋果／D3 改按個，醬油／米酒改按容量，重複的店家 "Fulham Green" 已軟刪除（修正前備份在當時的 scratchpad，已不可靠，以 git 與 D1 為準）

## 必讀檔案

- `CLAUDE.md` —— 這次改了三條定案規則（介面只用中文、單品排行不分組、按鈕都在底部），新 session 一定要先讀，不然會改回去
- `public/app.js` —— `sheet()` / `menuSheet()`（底部按鈕列）、`openRecordMenu()`、`recordBody()`、`openStorePicker()`、`reconcileUnit()`、`snapCandidates()`、`storeReport()`
- `public/units.js` —— `baseFromLabel()`（從標籤小字判斷按個／容量／重量）、`freshness(..., { promo })`
- `README.md` —— 作品集用的英文說明，**內容已經過時**（見下一步）

## 下一步

1. **等使用者真機回報**（iPhone 與安卓各一台）：拍照是否直接開相機、相簿是否跳照片圖庫、店家頁底部切換列會不會被 iPhone 底部橫條擋到、返回鍵能不能一層層關掉選單。真機沒跑過，只在 Playwright 模擬 360/375/412 寬度驗過
2. **更新 `README.md`**：它還寫「UI pairs Chinese with English」與「分組排行」，跟現在不符；截圖 `docs/screenshots/` 也是舊版介面，要重拍（375px 深色）
3. 本機 `README.zh.md`（gitignored）同步 README 的動機段落與這次改版
4. README 改完後重跑 `python scripts/public-snapshot.py <輸出資料夾>`，推到公開 repo `grocery-price-check`（仍是 private，要不要轉 public 是使用者決定）
5. 選做：巧克力杏仁堅果底下混了一筆「Forest Feast Peanut Butter & Chocolate Dates」且沒有容量，問使用者要拆成獨立品項還是刪掉

## 已知問題

- 測試方式：沒有密碼可登入，驗證是用 Playwright 攔截 `/api/session`、`/api/sync`、`/api/extract` 並灌正式資料副本；不能替使用者輸入密碼
- **`docs/handoff/` 會被 `scripts/public-snapshot.py` 一起複製進公開快照**。本文件刻意不寫個人網址與資源 ID，掃描才不會失敗；之後寫 handoff 也要避開，或在腳本裡排除 `docs/handoff/`
- 搜尋框刻意留在頂端（底部在 iPhone 會被鍵盤擋），使用者若要求移到底部，需要處理 visualViewport 與鍵盤
- toast 固定在選單列上方，在店家頁會蓋住底部的店家切換列幾秒，尚未處理
