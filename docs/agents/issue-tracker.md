# 議題追蹤

- 使用 `.scratch/<feature>/` 管理各功能的規格與工單。新功能的規格放在 `.scratch/<feature>/spec.md`。既有 `maplestory-notice` 功能的規格在根目錄 `SPEC.md`。
- 每張實作工單各用一個 Markdown 檔案，放在 `.scratch/<feature>/issues/<NN>-<slug>.md`，從 `01` 編號。新增工單時使用下一個可用編號。
- 在工單頂部附近的 `Status:` 欄位記錄分類狀態，並沿用檔案現有的欄位格式。標籤見 [分類標籤](triage-labels.md)。留言與討論追加至工單末尾的 `## Comments`。
- 技能要求發布規格或工單時，依上述路徑建立檔案。要求讀取工單時，依使用者提供的路徑或功能與編號查找。

## Wayfinder

- 導覽圖放在 `.scratch/<effort>/map.md`。子工單放在 `.scratch/<effort>/issues/NN-<slug>.md`。
- 子工單以 `Type:` 記錄 `research`、`prototype`、`grilling` 或 `task`。這類工單以 `Status:` 記錄 `claimed` 或 `resolved`。
- `Blocked by:` 列出前置工單。前置工單全部標記為 `resolved` 後，才可處理該工單。
- 按編號選擇最早未結案、無阻擋且無人認領的工單，將狀態設為 `claimed` 後開始。
- 完成時將答案加入 `## Answer`，把狀態設為 `resolved`，並在導覽圖的 `Decisions-so-far` 加入摘要與連結。
