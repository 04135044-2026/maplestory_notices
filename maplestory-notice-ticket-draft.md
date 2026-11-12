# 新楓之谷公告懶人包任務索引

版本 1.2｜復盤修訂，供重新實作。基線見 [SPEC.md](SPEC.md) 及 [GLOSSARY.md](GLOSSARY.md)。下表的獨立文件是正式任務票，執行狀態從待實作開始。

先用 `implement` 執行任務 01。依票內順序先看文字示意，再實作並啟動網站，以公告 19129 驗收。等使用者確認第一條查閱流程後，再依前置關係進行。任務 16 有日曆示意確認點。每張完成後保留驗收結果，以繁體中文提交。使用短期分支承接一個可驗收改動，包含該功能涉及的所有分頁。

| 任務 | 直接前置 |
| --- | --- |
| [01: 讓玩家從首頁找到指定獎勵並讀懂取得方式](.scratch/maplestory-notice/issues/01-import-official-notice.md) | 無 |
| [02: 依頁面模板拆分多活動與取得方法](.scratch/maplestory-notice/issues/02-split-by-page-template.md) | 01 |
| [03: 檢視並調整待確認的活動拆分](.scratch/maplestory-notice/issues/03-confirm-activity-segmentation.md) | 02 |
| [04: 整理圖片表格並呈現官方獎勵外觀](.scratch/maplestory-notice/issues/04-extract-images-and-reward-appearance.md) | 03 |
| [05: 區分活動期限與顯示活動狀態](.scratch/maplestory-notice/issues/05-activity-periods-and-status.md) | 01 |
| [06: 首頁篩選及從獎勵反查活動](.scratch/maplestory-notice/issues/06-search-activities-and-rewards.md) | 04、05 |
| [07: 區塊更新與共用條件影響追蹤](.scratch/maplestory-notice/issues/07-incremental-block-updates.md) | 04 |
| [08: 用訂閱Codex整理指定批次並切換預設](.scratch/maplestory-notice/issues/08-codex-subscription-batches.md) | 07 |
| [09: 合併多來源與顯示官方更正差異](.scratch/maplestory-notice/issues/09-merge-sources-and-corrections.md) | 05、07 |
| [10: 回溯180天並發現新的相關公告](.scratch/maplestory-notice/issues/10-discover-and-backfill-notices.md) | 09 |
| [11: 依活動期限持續追蹤既有來源](.scratch/maplestory-notice/issues/11-track-active-notice-sources.md) | 10 |
| [12: 每日固定更新與錯過排程補查](.scratch/maplestory-notice/issues/12-daily-schedule-and-catch-up.md) | 10 |
| [13: 受控批次、失敗重試與待處理工作](.scratch/maplestory-notice/issues/13-bounded-batches-and-retries.md) | 10 |
| [14: 關注活動獎勵與站內更新提示](.scratch/maplestory-notice/issues/14-watch-activities-and-rewards.md) | 06、09 |
| [15: 修正摘要、保留個人修改及還原](.scratch/maplestory-notice/issues/15-preserve-manual-corrections.md) | 09 |
| [16: 網站日曆與選取活動匯出](.scratch/maplestory-notice/issues/16-calendar-and-ics-export.md) | 05 |
| [17: 週期提醒及來源更正後重新匯出提示](.scratch/maplestory-notice/issues/17-recurring-reminders-and-reexport.md) | 09、16 |
| [18: 已知修復問題清單及活動關聯](.scratch/maplestory-notice/issues/18-known-and-fixed-issues.md) | 10 |
| [19: 備份還原完整本機資料並離線核對](.scratch/maplestory-notice/issues/19-backup-restore-and-offline.md) | 08、14、15、17、18 |
| [20: 代表公告品質比較與完整流程驗收](.scratch/maplestory-notice/issues/20-representative-mvp-acceptance.md) | 11、12、13、19 |
