# Malleable Resume Server

后端服务器 - AI 简历解析与改写 API

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/rewrite` | POST | JD 驱动简历改写（2x3 矩阵） |
| `/api/rewrite-simple` | POST | 区域智能改写 |
| `/api/parse` | POST | 简历文件解析 |
| `/api/parse-multiple` | POST | 多文件合并分析 |
| `/api/analyze-jd` | POST | JD 分析 |
| `/api/chat` | POST | AI 对话 |
| `/api/parse-raw-text` | POST | 前端 OCR 文字解析 |

## 环境变量

```env
API_KEY=sk-xxx
API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
API_MODEL=qwen-plus
PORT=3000
```

## 部署到 Render

1. 在 Render 创建新 Web Service
2. 连接此 GitHub 仓库
3. Root Directory 设为 `server`
4. Build Command: `npm install`
5. Start Command: `node index.js`
6. 添加环境变量

## 本地开发

```bash
npm install
node index.js
```
