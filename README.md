# WorkBuddy 待办清单

一个零依赖的 Node.js 待办应用。浏览器页面和 WorkBuddy 的 MCP 工具通过同一个 HTTP API 读写待办事项，数据保存在本地的 `data/todos.json`。

## 启动项目

需要 Git 和 Node.js 18 或更新版本。克隆仓库后可以直接启动，无需安装依赖。

```sh
git clone https://github.com/laohan-repos/workbuddy-mcp-workspace-todo-list.git
cd workbuddy-mcp-workspace-todo-list
npm start
```

保持这个终端运行，在浏览器打开 [http://localhost:3000](http://localhost:3000)。首次添加待办时，应用会创建数据文件。

## 在 WorkBuddy 中配置 MCP

1. 在 WorkBuddy 左侧打开「专家 · 技能 · 连接器」，进入「连接器」。
2. 点击「自定义连接器」，在「MCP 服务管理」中点击「添加 MCP」。
3. 在打开的 `mcp.json` 中加入下面的配置。如果已有 `mcpServers`，把 `todo-app` 条目合并进去。
4. 保存配置。如果 WorkBuddy 提示是否信任该 MCP，点击「信任」。

```json
{
  "mcpServers": {
    "todo-app": {
      "type": "stdio",
      "command": "node",
      "args": ["/绝对路径/workbuddy-mcp-workspace-todo-list/mcp/todo-mcp.js"],
      "env": {
        "TODO_API_BASE": "http://127.0.0.1:3000"
      }
    }
  }
}
```

- 把 `args` 中的示例替换成你电脑上 `mcp/todo-mcp.js` 的绝对路径。macOS 或 Linux 下可在仓库目录运行 `pwd`，再拼上 `/mcp/todo-mcp.js`。Windows 的 JSON 路径可以使用正斜杠，例如 `C:/Projects/workbuddy-mcp-workspace-todo-list/mcp/todo-mcp.js`。
- 如果 WorkBuddy 找不到 `node`，用 Node.js 可执行文件的绝对路径替换 `command`。macOS 或 Linux 下运行 `command -v node` 查询，Windows 下运行 `where.exe node` 查询。
- WorkBuddy 会启动 MCP 进程。使用时保持 `npm start` 运行，让 MCP 能访问待办 API。如果修改了应用的 `PORT`，也要把 `TODO_API_BASE` 改成对应端口。

保存后，在 WorkBuddy 对话中输入「用 todo-app 列出我的待办」，验证是否能读取网页中的待办事项。也可以输入「用 todo-app 添加一条待办：整理会议纪要」，再到网页确认新增记录。

[WorkBuddy 官方 MCP 指南](https://www.codebuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide) · [腾讯设计文档中的连接器操作步骤](https://docs.ardot.tencent.com/ardot-mcp/ide-integration.html)
