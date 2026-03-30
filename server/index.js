const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ========== 文件解析器 ==========
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
// 注意：tesseract.js 在 Node.js 环境有兼容性问题，OCR 功能已移至前端

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 配置 - 允许所有来源（生产环境建议限制具体域名）
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// 配置 multer 处理文件上传
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB 限制
});

// ========== 工具函数：调用大模型 ==========
async function callLLM(messages, expectJson = false) {
    const bodyPayload = {
        model: process.env.API_MODEL || 'deepseek-chat',
        messages: messages
    };
    if (expectJson) {
        bodyPayload.response_format = { type: "json_object" };
    }

    const response = await fetch(process.env.API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.API_KEY}`
        },
        body: JSON.stringify(bodyPayload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

// ========== 文件提取文字（纯文字提取，无 OCR） ==========
async function extractTextFromFile(filePath, originalName) {
    const ext = path.extname(originalName).toLowerCase();
    let text = '';
    let isImagePdf = false;

    console.log('[extractTextFromFile] 文件路径:', filePath, '扩展名:', ext);

    try {
        if (ext === '.pdf') {
            console.log('[extractTextFromFile] 开始读取 PDF...');
            const dataBuffer = fs.readFileSync(filePath);
            console.log('[extractTextFromFile] PDF 大小:', dataBuffer.length, 'bytes');

            const data = await pdfParse(dataBuffer);
            console.log('[extractTextFromFile] PDF 解析结果:', data ? '有数据' : '无数据');

            // 安全检查：确保 data 和 data.text 存在
            if (!data) {
                console.warn('[extractTextFromFile] PDF 解析返回空数据');
                text = '';
            } else if (!data.text) {
                console.warn('[extractTextFromFile] PDF 解析返回的 data.text 为空');
                text = '';
            } else {
                text = data.text;
            }

            console.log('[extractTextFromFile] 提取的文字长度:', text.length);

            // 如果文字太少（少于 100 字符），标记为图片型 PDF
            if (text.length < 100) {
                console.log('[警告] PDF 文字提取不足 100 字符，可能是图片型 PDF');
                isImagePdf = true;
            }
            return { text, isImagePdf };

        } else if (ext === '.docx') {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value || '';
        } else if (ext === '.doc') {
            // .doc 格式不支持，返回错误
            throw new Error('.doc 格式不支持，请另存为 .docx 或 PDF 格式');
        } else if (ext === '.txt') {
            return fs.readFileSync(filePath, 'utf-8');
        } else if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.gif' || ext === '.webp') {
            // 图片格式，返回标记让前端使用 OCR
            console.log('[extractTextFromFile] 图片格式文件，需要 OCR');
            return { text: '', isImagePdf: true, requiresOcr: true, imageType: ext };
        } else {
            // 其他不支持的格式
            throw new Error(`不支持的文件格式：${ext}`);
        }
    } catch (error) {
        console.error('[extractTextFromFile] 错误:', error);
        throw new Error(`文件解析失败：${error.message}`);
    }
}

// ========== API 路由 ==========

// 1. JD 驱动的简历改写
app.post('/api/rewrite', async (req, res) => {
    try {
        const { jd, resumeBullet } = req.body;

        if (!jd || !resumeBullet) {
            return res.status(400).json({ error: '缺少 JD 或简历内容' });
        }

        const messages = [
            {
                role: "system",
                content: '你是一个资深交互设计总监。请根据目标岗位要求 (JD)，重写用户的简历。必须输出 JSON 格式，包含一个 "aiMatrix" 二维数组。外层数组代表 2 个不同的重写视角（如：技术导向、业务导向），内层代表该视角下的 3 种长度变体（极简一句话、适中两句话、详尽三句话）。必须严格按照 2x3 格式输出。示例：{"aiMatrix": [["短版本 1","中版本 1","长版本 1"], ["短版本 2","中版本 2","长版本 2"]]}'
            },
            {
                role: "user",
                content: `目标 JD:\n${jd}\n\n原简历条目:\n${resumeBullet}`
            }
        ];

        const responseText = await callLLM(messages, true);
        const data = JSON.parse(responseText);

        // 容错处理：确保 aiMatrix 是 2x3 格式
        if (!data.aiMatrix || !Array.isArray(data.aiMatrix)) {
            throw new Error('AI 返回格式错误');
        }

        // 如果返回的是扁平数组，尝试转换为 2x3
        if (data.aiMatrix.length === 6 && !Array.isArray(data.aiMatrix[0])) {
            data.aiMatrix = [
                data.aiMatrix.slice(0, 3),
                data.aiMatrix.slice(3, 6)
            ];
        }
        // 如果只有 1 个视角，复制一份
        if (data.aiMatrix.length === 1) {
            data.aiMatrix = [data.aiMatrix[0], data.aiMatrix[0]];
        }
        // 确保每个视角有 3 个长度变体
        data.aiMatrix = data.aiMatrix.map(view => {
            if (!Array.isArray(view)) return [view, view, view];
            if (view.length === 1) return [view[0], view[0], view[0]];
            if (view.length === 2) return [view[0], view[1], view[1]];
            return view.slice(0, 3);
        });

        res.json({ success: true, data });
    } catch (error) {
        console.error('Rewrite error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. 简历文件解析 + 智能重写
app.post('/api/parse', upload.single('file'), async (req, res) => {
    try {
        console.log('[/api/parse] req.file:', req.file);
        console.log('[/api/parse] req.body:', req.body);

        if (!req.file) {
            return res.status(400).json({ error: '未上传文件' });
        }

        const startTime = Date.now();
        console.log(`\n[解析开始] 文件：${req.file.originalname}, 大小：${req.file.size} bytes`);

        // 提取文字
        console.log('[步骤 1/3] 提取文字...');
        const extractResult = await extractTextFromFile(req.file.path, req.file.originalname);
        const rawText = extractResult.text || '';
        const isImagePdf = extractResult.isImagePdf || false;

        console.log(`[步骤 1 完成] 提取了 ${rawText.length} 字符，isImagePdf: ${isImagePdf}，耗时 ${Date.now() - startTime}ms`);

        // ★ 如果是图片型 PDF 或图片格式，返回错误，提示用户使用前端 OCR
        if (isImagePdf) {
            fs.unlinkSync(req.file.path);
            const ocrMessage = extractResult.requiresOcr
                ? '该文件是图片格式（JPG/PNG），需要 OCR 识别。请点击"启动 OCR"按钮，AI 将自动识别图片中的文字。'
                : '该 PDF 是图片格式，需要 OCR 识别。请使用前端 OCR 功能（推荐）或上传文字版简历。';
            return res.json({
                success: false,
                error: extractResult.requiresOcr ? '图片格式文件' : '图片型 PDF',
                message: ocrMessage,
                requiresOcr: true,
                extractedText: rawText  // 如果有少量文字，也返回
            });
        }

        // ★ 提炼重写版提示词 - AI 深度分析模式
        const messages = [
            {
                role: "system",
                content: `你是一位资深简历顾问，擅长从求职者材料中提炼亮点并重写成专业简历。

## 任务
分析用户提供的简历/材料，提取关键信息并生成结构化 JSON。

## 输出格式（必须严格遵守）
{
  "basicInfo": {
    "name": "姓名（必填）",
    "age": 年龄（数字，如无则 null）,
    "gender": "性别（男/女，如无则 null）",
    "contact": {
      "phone": "电话",
      "email": "邮箱",
      "wechat": "微信（可选）",
      "location": "城市（可选）"
    },
    "missingFields": ["AI 未识别到需要用户手动填写的字段名列表"]
  },
  "education": [
    {"school": "学校", "degree": "学历（本科/硕士/博士）", "major": "专业", "duration": "时间（如 2025.09 - 至今）", "gpa": "GPA（可选）"}
  ],
  "experiences": [
    {
      "type": "internship|project|campus|work",
      "title": "公司名/项目名/组织名",
      "role": "职位/角色",
      "duration": "时间",
      "bullets": ["AI 提炼重写的经历描述，每条 1-2 句话，突出成果和量化数据"]
    }
  ],
  "skills": ["技能关键词列表，如'用户研究'、'Python'、'产品设计'等"],
  "summary": "AI 分析得出的个人优势总结（2-3 句话，突出与互联网岗位相关的能力）"
}

## 要求
1. 基本信息缺失时，对应字段设为 null，并将字段名加入 missingFields
2. 经历描述要主动提炼亮点，用 STAR 法则重写（情境 - 任务 - 行动 - 结果）
3. 有量化数据优先保留（如"提升 30% 转化率"）
4. 技能从经历中提炼，不要编造
5. 材料中无法确定的信息设为 null，不要编造`
            },
            {
                role: "user",
                content: `以下是简历/材料内容，请分析并生成结构化简历：\n\n${rawText.substring(0, 4000)}`  // 增加长度限制以获取更多信息
            }
        ];

        console.log('[步骤 2/3] 调用 AI 解析...');
        const aiStart = Date.now();
        const responseText = await callLLM(messages, true);
        console.log(`[步骤 2 完成] AI 耗时 ${Date.now() - aiStart}ms`);

        // ★ 容错处理：确保 AI 返回了有效的 JSON
        let parsedData;
        try {
            parsedData = JSON.parse(responseText);
        } catch (parseError) {
            console.error('[解析错误] AI 返回的 JSON 解析失败:', parseError);
            console.error('[原始响应]', responseText.substring(0, 500));
            fs.unlinkSync(req.file.path);
            return res.json({
                success: false,
                error: 'AI 解析失败',
                message: 'AI 返回的数据格式有误，请稍后重试或上传文字版简历。',
                extractedText: rawText.substring(0, 500)
            });
        }

        // 清理临时文件
        fs.unlinkSync(req.file.path);

        const totalTime = Date.now() - startTime;
        console.log(`[解析完成] 总耗时：${totalTime}ms`);

        // ★ 空数据校验：检查解析结果是否有实际内容
        // 注意：AI 返回的格式是 basicInfo.name，不是 name
        const hasContent = parsedData && (
            (parsedData.basicInfo && parsedData.basicInfo.name && parsedData.basicInfo.name.trim().length > 0) ||
            (parsedData.education && Array.isArray(parsedData.education) && parsedData.education.length > 0) ||
            (parsedData.experiences && Array.isArray(parsedData.experiences) && parsedData.experiences.length > 0)
        );

        if (!hasContent) {
            console.warn('[解析警告] AI 返回空数据，可能是简历格式问题');
            return res.json({
                success: false,
                error: '无法解析简历内容',
                message: '无法从简历中提取有效信息，请检查文件格式或手动输入内容。',
                extractedText: rawText.substring(0, 500)  // 返回提取到的文字（如果有）
            });
        }

        res.json({
            success: true,
            data: parsedData,
            timing: {
                total: totalTime,
                extraction: Date.now() - startTime - 100, // 估算
                ai: totalTime - (Date.now() - startTime) + 100
            }
        });
    } catch (error) {
        console.error('Parse error:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: error.message });
    }
});

// 3. AI Copilot 对话
app.post('/api/chat', async (req, res) => {
    try {
        const { message, context } = req.body;

        if (!message) {
            return res.status(400).json({ error: '缺少消息内容' });
        }

        const messages = [
            {
                role: "system",
                content: '你是一个专业的简历优化导师和职业规划顾问。回答要精简、专业、带有一点极客感。擅长帮助用户挖掘经历亮点、优化表达方式、提供求职建议。'
            },
            {
                role: "user",
                content: context ? `当前简历上下文：${context}\n\n用户问题：${message}` : message
            }
        ];

        const reply = await callLLM(messages);
        res.json({ success: true, reply });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. 解析原始文字（前端 OCR 专用）
app.post('/api/parse-raw-text', async (req, res) => {
    try {
        const { rawText } = req.body;

        if (!rawText || rawText.trim().length === 0) {
            return res.status(400).json({ error: '缺少文字内容' });
        }

        console.log(`\n[解析开始] 前端 OCR 提取的文字，长度：${rawText.length} 字符`);

        const startTime = Date.now();

        // ★ 提炼重写版提示词 - 与/api/parse 保持一致
        const messages = [
            {
                role: "system",
                content: `你是一位资深简历顾问，擅长从求职者材料中提炼亮点并重写成专业简历。

## 任务
分析用户提供的简历/材料，提取关键信息并生成结构化 JSON。

## 输出格式（必须严格遵守）
{
  "basicInfo": {
    "name": "姓名（必填）",
    "age": 年龄（数字，如无则 null）,
    "gender": "性别（男/女，如无则 null）",
    "contact": {
      "phone": "电话",
      "email": "邮箱",
      "wechat": "微信（可选）",
      "location": "城市（可选）"
    },
    "missingFields": ["AI 未识别到需要用户手动填写的字段名列表"]
  },
  "education": [
    {"school": "学校", "degree": "学历（本科/硕士/博士）", "major": "专业", "duration": "时间（如 2025.09 - 至今）", "gpa": "GPA（可选）"}
  ],
  "experiences": [
    {
      "type": "internship|project|campus|work",
      "title": "公司名/项目名/组织名",
      "role": "职位/角色",
      "duration": "时间",
      "bullets": ["AI 提炼重写的经历描述，每条 1-2 句话，突出成果和量化数据"]
    }
  ],
  "skills": ["技能关键词列表，如'用户研究'、'Python'、'产品设计'等"],
  "summary": "AI 分析得出的个人优势总结（2-3 句话，突出与互联网岗位相关的能力）"
}

## 要求
1. 基本信息缺失时，对应字段设为 null，并将字段名加入 missingFields
2. 经历描述要主动提炼亮点，用 STAR 法则重写（情境 - 任务 - 行动 - 结果）
3. 有量化数据优先保留（如"提升 30% 转化率"）
4. 技能从经历中提炼，不要编造
5. 材料中无法确定的信息设为 null，不要编造`
            },
            {
                role: "user",
                content: `以下是简历/材料内容，请分析并生成结构化简历：\n\n${rawText.substring(0, 5000)}`  // 前端 OCR 可能提取更多文字
            }
        ];

        console.log('[步骤 1/2] 调用 AI 解析...');
        const aiStart = Date.now();
        const responseText = await callLLM(messages, true);
        console.log(`[步骤 1 完成] AI 耗时 ${Date.now() - aiStart}ms`);

        const parsedData = JSON.parse(responseText);

        const totalTime = Date.now() - startTime;
        console.log(`[解析完成] 总耗时：${totalTime}ms`);

        res.json({
            success: true,
            data: parsedData,
            timing: {
                total: totalTime,
                ai: totalTime - 100
            }
        });
    } catch (error) {
        console.error('Parse raw text error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. 多文件合并分析
app.post('/api/parse-multiple', upload.array('files', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: '未上传文件' });
        }

        const startTime = Date.now();
        console.log(`\n[多文件解析开始] 文件数量：${req.files.length}`);
        req.files.forEach(f => console.log(`  - ${f.originalname}`));

        // 提取所有文件的文字并合并
        let combinedText = '';
        const fileTexts = [];

        for (const file of req.files) {
            try {
                const extractResult = await extractTextFromFile(file.path, file.originalName);
                if (extractResult.text) {
                    fileTexts.push({
                        name: file.originalname,
                        text: extractResult.text.substring(0, 2000)
                    });
                    combinedText += `\n\n--- [文件：${file.originalname}] ---\n${extractResult.text}\n`;
                }
                // 清理临时文件
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            } catch (error) {
                console.log(`[警告] 文件 ${file.originalname} 解析失败：${error.message}`);
            }
        }

        console.log(`[文字提取完成] 合并后总字符数：${combinedText.length}`);

        if (combinedText.trim().length === 0) {
            return res.status(400).json({ error: '所有文件均无法提取文字' });
        }

        // 调用 AI 分析合并后的内容
        console.log('[步骤 2/3] 调用 AI 分析...');
        const messages = [
            {
                role: "system",
                content: `你是一位资深简历顾问，擅长从求职者材料中提炼亮点并重写成专业简历。

## 任务
分析用户提供的多份材料（简历/论文/作品集等），提取关键信息并生成结构化简历 JSON。

## 输出格式（必须严格遵守）
{
  "basicInfo": {
    "name": "姓名（必填）",
    "age": 年龄（数字，如无则 null）,
    "gender": "性别（男/女，如无则 null）",
    "contact": {
      "phone": "电话",
      "email": "邮箱",
      "wechat": "微信（可选）",
      "location": "城市（可选）"
    },
    "missingFields": ["AI 未识别到需要用户手动填写的字段名列表"]
  },
  "education": [
    {"school": "学校", "degree": "学历（本科/硕士/博士）", "major": "专业", "duration": "时间（如 2025.09 - 至今）", "gpa": "GPA（可选）"}
  ],
  "experiences": [
    {
      "type": "internship|project|campus|work",
      "title": "公司名/项目名/组织名",
      "role": "职位/角色",
      "duration": "时间",
      "bullets": ["AI 提炼重写的经历描述，每条 1-2 句话，突出成果和量化数据"]
    }
  ],
  "skills": ["技能关键词列表，如'用户研究'、'Python'、'产品设计'等"],
  "summary": "AI 分析得出的个人优势总结（2-3 句话，突出与互联网岗位相关的能力）"
}

## 要求
1. 基本信息缺失时，对应字段设为 null，并将字段名加入 missingFields
2. 经历描述要主动提炼亮点，用 STAR 法则重写（情境 - 任务 - 行动 - 结果）
3. 有量化数据优先保留（如"提升 30% 转化率"）
4. 技能从经历中提炼，不要编造
5. 材料中无法确定的信息设为 null，不要编造
6. 多份材料之间有冲突时，以简历文件为准`
            },
            {
                role: "user",
                content: `以下是多份材料的合并内容，请分析并生成结构化简历：\n\n${combinedText.substring(0, 8000)}`
            }
        ];

        const aiStart = Date.now();
        const responseText = await callLLM(messages, true);
        console.log(`[AI 分析完成] 耗时：${Date.now() - aiStart}ms`);

        const parsedData = JSON.parse(responseText);

        const totalTime = Date.now() - startTime;
        console.log(`[多文件解析完成] 总耗时：${totalTime}ms`);

        res.json({
            success: true,
            data: parsedData,
            timing: {
                total: totalTime,
                ai: totalTime - (Date.now() - startTime - (aiStart - Date.now()))
            }
        });
    } catch (error) {
        console.error('Parse multiple error:', error);
        // 清理临时文件
        if (req.files) {
            req.files.forEach(file => {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            });
        }
        res.status(500).json({ error: error.message });
    }
});

// 6. JD 分析 - 提炼核心要求卡片 + 公司信息
app.post('/api/analyze-jd', async (req, res) => {
    try {
        const { jdText } = req.body;

        if (!jdText || jdText.trim().length === 0) {
            return res.status(400).json({ error: '缺少 JD 内容' });
        }

        console.log(`\n[JD 分析开始] JD 长度：${jdText.length} 字符`);

        const messages = [
            {
                role: "system",
                content: `你是一位资深招聘专家，擅长从岗位描述 (JD) 中提炼核心要求和公司信息。

## 任务
分析 JD，提取：
1. 3-5 个核心能力要求
2. 公司信息和岗位信息
3. 公司简介（50 字以内）

## 输出格式（必须严格遵守 JSON 格式）
{
  "keyRequirements": [
    {
      "title": "能力名称（4-8 个字，如'多模态技术'、'用户研究能力'）",
      "description": "具体要求描述（1-2 句话，来自 JD 原文的提炼）",
      "priority": "high|medium|low（高/中/低优先级，根据 JD 中的重要程度判断）"
    }
  ],
  "companyInfo": {
    "companyName": "公司名（从 JD 标题或内容中提取）",
    "position": "岗位名（从 JD 标题或内容中提取）",
    "description": "50 字以内的公司介绍，突出技术栈、团队规模、业务方向等"
  }
}

## 要求
1. 只提取真正核心的能力要求，不要提取福利、办公地点等次要信息
2. title 要简洁有力，适合作为卡片标题
3. description 要具体，能够指导简历改写
4. priority 判断标准：
   - high: JD 中明确强调、反复提及的核心能力，或岗位名称直接相关的能力
   - medium: 岗位需要的重要能力，但不是最核心的
   - low: 加分项或辅助性能力
5. 按重要性排序，最重要的排在前面
6. 公司信息和岗位信息：如果 JD 中没有明确公司名，用"贵公司"代替
7. 公司简介要精炼、有吸引力，50 字以内
8. 必须输出合法的 JSON 格式`
            },
            {
                role: "user",
                content: `请分析以下 JD，提取核心能力要求和公司信息，输出 JSON 格式：\n\n${jdText.substring(0, 5000)}`
            }
        ];

        const responseText = await callLLM(messages, true);
        const data = JSON.parse(responseText);

        // 确保至少有一个要求
        if (!data.keyRequirements || data.keyRequirements.length === 0) {
            return res.json({
                success: false,
                error: '无法从 JD 中提取核心要求',
                message: '请检查 JD 内容是否完整'
            });
        }

        console.log(`[JD 分析完成] 提取了 ${data.keyRequirements.length} 个核心要求`);

        res.json({ success: true, data });
    } catch (error) {
        console.error('Analyze JD error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 7. 针对特定区域的智能改写（技能区/总结区/项目经历区）
app.post('/api/rewrite-simple', async (req, res) => {
    try {
        const { jd, resumeBullet, sectionType } = req.body;

        if (!jd || !resumeBullet || !sectionType) {
            return res.status(400).json({ error: '缺少 JD、简历内容或区域类型' });
        }

        const startTime = Date.now();
        console.log(`\n[区域改写] 区域类型：${sectionType}, JD: ${jd.substring(0, 50)}...`);

        // 根据不同区域类型使用不同提示词
        const sectionPrompts = {
            'experience': {
                role: "资深产品总监和技术面试官",
                style: "用 STAR 法则（情境 - 任务 - 行动 - 结果）重写项目经历，动词开头（如主导、负责、推动），带量化数据（如提升 50%、减少 30% 时间）",
                outputFormat: "一段话，1-2 句话，突出技术能力和业务成果"
            },
            'skills': {
                role: "技术面试官和技能培训师",
                style: "从 JD 中提炼 3-5 个具体的子技能或应用场景，用顿号分隔",
                outputFormat: "技能关键词列表，如'掌握 XX、XX、XX 等技术'"
            },
            'summary': {
                role: "招聘专家和职业规划顾问",
                style: "整合个人能力与岗位要求的匹配点，突出独特优势和差异化竞争力",
                outputFormat: "2-3 句话的个人优势陈述，语气自信但不夸张"
            },
            'summary_append': {
                role: "招聘专家和职业规划顾问",
                style: "用户已有一段个人总结，请根据 JD 要求补充 1 句话突出与岗位匹配的优势。**只返回新增的那句话，不要重复原有内容**",
                outputFormat: "1 句话的新增内容，直接可以追加到原文后面"
            }
        };

        const sectionConfig = sectionPrompts[sectionType] || sectionPrompts['experience'];

        const messages = [
            {
                role: "system",
                content: `你是一位${sectionConfig.role}。请根据岗位要求 (JD) 重写用户的简历内容。

## 要求
- ${sectionConfig.style}
- 输出格式：${sectionConfig.outputFormat}
- 不要编造用户没有的经历，基于原内容优化表达
- 语言精炼、专业，符合互联网行业简历风格`
            },
            {
                role: "user",
                content: `岗位要求：${jd}\n\n原内容：${resumeBullet}`
            }
        ];

        const responseText = await callLLM(messages, false); // 不需要 JSON 格式

        // 返回单段文字，不包装成矩阵
        res.json({
            success: true,
            data: {
                snippet: responseText.trim(),
                sectionType: sectionType
            },
            timing: {
                total: Date.now() - startTime
            }
        });
    } catch (error) {
        console.error('Rewrite simple error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`🚀 AI Resume Server running on http://localhost:${PORT}`);
    console.log(`📝 Available endpoints:`);
    console.log(`   GET  /health            - 健康检查`);
    console.log(`   POST /api/rewrite       - JD 驱动改写（2x3 矩阵）`);
    console.log(`   POST /api/rewrite-simple - 区域智能改写（单段文字）`);
    console.log(`   POST /api/parse         - 简历解析（单文件）`);
    console.log(`   POST /api/parse-multiple - 多文件合并分析`);
    console.log(`   POST /api/analyze-jd    - JD 分析`);
    console.log(`   POST /api/chat          - AI 对话`);
    console.log(`   POST /api/parse-raw-text - 前端 OCR 文字解析`);
});
