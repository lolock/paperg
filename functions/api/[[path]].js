/**
 * Cloudflare Worker entry point for handling API requests.
 * Intercepts requests made to /api/*
 *
 * Environment variables expected:
 * - OPENAI_API_KEY: Your OpenAI-compatible API key (Secret).
 * - API_ENDPOINT: The BASE URL for the LLM API endpoint (e.g., "https://api.openai.com/v1").
 * - SYSTEM_PROMPT: The system prompt for the LLM.
 * - LLM_MODEL: The model name to use (e.g., "gpt-4", "gpt-3.5-turbo").
 * - KV_NAMESPACE: Binding to the Cloudflare KV namespace (for auth codes & usage).
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Only respond to requests starting with /api/
  if (!url.pathname.startsWith('/api/')) {
    return new Response('Not Found', { status: 404 });
  }

  // Handle CORS preflight requests first
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  let response; // Variable to hold the eventual response object

  try {
    // --- Request Routing ---
    if (url.pathname === '/api/login' && request.method === 'POST') {
      response = await handleLoginRequest(request, env);
    } else if (url.pathname === '/api/chat' && request.method === 'POST') {
      response = await handleChatRequest(request, env);
    } else {
      // Route not found or method not allowed
      console.warn(`No matching route found for ${request.method} ${url.pathname}.`); // Keep warning for unmatched routes
      response = new Response(JSON.stringify({ error: 'API route not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Ensure we always have a Response object after the handler call
    if (!(response instanceof Response)) {
        console.error("Handler did not return a valid Response object. Assigning 500."); // Keep critical error
        response = new Response(JSON.stringify({ error: 'Internal Server Error: Invalid handler response' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }

  } catch (error) {
    // Catch unexpected errors during request routing or handler execution itself
    console.error('Error during request handling or handler execution:', error); // Keep critical error
    response = new Response(JSON.stringify({ error: 'Internal Server Error', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --- Add CORS Headers to the final response ---
  const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // Consider restricting in production
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const responseHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
      responseHeaders.set(key, value);
  });

  // Return the final response
  return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
  });
}

/**
 * Handles CORS preflight requests (OPTIONS).
 */
function handleOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400',
        },
    });
}

/**
 * Handles the /api/login POST request using KV validation.
 * @param {Request} request
 * @param {object} env - Contains KV_NAMESPACE binding
 * @returns {Promise<Response>}
 */
async function handleLoginRequest(request, env) {
  try {
    // Validate request
    if (!request.headers.get('content-type')?.includes('application/json')) {
       return new Response(JSON.stringify({ error: 'Invalid request body type. Expected JSON.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    let body;
    try { body = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON format in request body.'}), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
    const providedCode = body.code;
    if (!providedCode) {
       return new Response(JSON.stringify({ error: 'Login code is required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // --- KV Validation Logic ---
    if (!env.KV_NAMESPACE) {
        console.error("KV_NAMESPACE binding is not configured in environment."); // Keep critical config error
        return new Response(JSON.stringify({ error: 'Server configuration error: KV Namespace not bound.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const kvValue = await env.KV_NAMESPACE.get(providedCode);

    if (kvValue !== null) { // Key exists - Login code is potentially valid
      // {{ 编辑 1: 恢复之前的逻辑，仅在状态无效或解析失败时初始化 }}
      let stateValid = false;
      try {
        const currentState = JSON.parse(kvValue);
        // 仅验证状态是否是对象并且有 status 属性
        if (currentState && typeof currentState === 'object' && typeof currentState.status !== 'undefined') {
          console.log(`[handleLoginRequest] User ${providedCode} logged in with existing valid state: ${currentState.status}`);
          stateValid = true;
        } else {
           console.log(`[handleLoginRequest] Parsed state for ${providedCode} is invalid or missing status. Will initialize if needed.`);
        }
      } catch (parseError) {
        // JSON 解析失败，说明 KV 中的值不是有效的状态对象
        console.log(`[handleLoginRequest] Failed to parse KV value for ${providedCode}. Will initialize. Error: ${parseError.message}`);
      }

      // 如果状态无效或解析失败，则进行初始化 (确保至少有一个基本状态)
      if (!stateValid) {
        try {
           const initialState = {
             status: 'AWAITING_INITIAL_INPUT',
             initial_requirements: null,
             outline: null,
             approved_outline: null,
             current_chapter_index: -1,
             confirmed_chapters: [],
             conversation_history: []
           };
           await env.KV_NAMESPACE.put(providedCode, JSON.stringify(initialState));
           console.log(`[handleLoginRequest] Initialized missing/invalid state for user ${providedCode}`);
        } catch (stateError) {
           console.error(`[handleLoginRequest] CRITICAL: Failed to initialize state for ${providedCode} during login! Error:`, stateError);
           return new Response(JSON.stringify({ error: 'Server error during state initialization.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      }
      // --- 登录成功 ---
      return new Response(JSON.stringify({ success: true, message: 'Login successful.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } else { // Key does not exist - Invalid login code
      console.warn(`[handleLoginRequest] Failed login attempt with non-existent KV code: ${providedCode}`);
      return new Response(JSON.stringify({ error: 'Invalid or expired login code.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    // --- End of KV Validation ---

  } catch (error) {
    console.error('[handleLoginRequest] Unexpected error caught:', error); // Keep critical error
    return new Response(JSON.stringify({ error: 'Failed to process login request.', details: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}



/**
 * Handles the /api/chat POST request using KV validation, state management, and calling LLM API.
 * @param {Request} request
 * @param {object} env - Environment object
 * @returns {Promise<Response>}
 */
async function handleChatRequest(request, env) {
  let currentState = null; // 用于存储用户当前状态
  let loginCode = null; // 用于存储登录码

  try {
    // --- Input Validation ---
    if (!request.headers.get('content-type')?.includes('application/json')) {
        return new Response(JSON.stringify({ error: 'Invalid request body type. Expected JSON.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    let body;
    try {
        body = await request.json();
    } catch (jsonError) {
        console.error('[handleChatRequest] Failed to parse request JSON body:', jsonError); // Keep error
        return new Response(JSON.stringify({ error: 'Invalid JSON format in request body.', details: jsonError.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const userMessage = body.message;
    loginCode = body.code;
    if (!userMessage || !loginCode) {
        return new Response(JSON.stringify({ error: 'Message and login code are required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // --- Re-validate Login Code using KV ---
    if (!env.KV_NAMESPACE) {
        console.error("[handleChatRequest] KV_NAMESPACE binding is not configured."); // Keep critical config error
        return new Response(JSON.stringify({ error: 'Server configuration error: KV Namespace not bound.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    
    // --- 读取并解析状态 ---
    try {
      const kvValue = await env.KV_NAMESPACE.get(loginCode);
      if (kvValue === null) {
        console.warn(`[handleChatRequest] Invalid/non-existent KV code during chat: ${loginCode}`); // Keep warning
        return new Response(JSON.stringify({ error: 'Invalid or expired login code.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      
      // 尝试解析状态，如果不是有效的JSON或没有状态信息，则初始化
      try {
        currentState = JSON.parse(kvValue);
        // 验证状态对象结构
        if (!currentState || typeof currentState !== 'object') {
          throw new Error("Invalid state structure");
        }
      } catch (parseError) {
        // 初始化默认状态
        currentState = {
          status: 'AWAITING_INITIAL_INPUT',
          initial_requirements: null,
          outline: null,
          approved_outline: null,
          current_chapter_index: -1,
          confirmed_chapters: [],
          conversation_history: []
        };
        console.log(`[handleChatRequest] Initializing new state for ${loginCode}`);
      }
    } catch (kvError) {
      console.error(`[handleChatRequest] Error accessing KV state:`, kvError);
      return new Response(JSON.stringify({ error: 'Failed to access user state.', details: kvError.message }), 
        { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // --- Get Configuration ---
    const apiKey = env.OPENAI_API_KEY;
    const apiBaseUrl = env.API_ENDPOINT || "https://api.openai.com/v1"; // Default base URL
    const baseSystemPrompt = env.SYSTEM_PROMPT || "You are a helpful assistant.";
    const modelName = env.LLM_MODEL || "gpt-3.5-turbo";

    if (!apiKey) {
        console.error("[handleChatRequest] OPENAI_API_KEY environment variable not set."); // Keep critical config error
        return new Response(JSON.stringify({ error: 'Server configuration error: Missing API Key.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // --- Construct Full URL ---
    let fullApiUrl;
    try {
        let standardizedBaseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
        fullApiUrl = standardizedBaseUrl.endsWith('/v1')
            ? `${standardizedBaseUrl}/chat/completions`
            : `${standardizedBaseUrl}/v1/chat/completions`;
        new URL(fullApiUrl); // Validate URL
    } catch (urlError) {
        console.error(`[handleChatRequest] Invalid API_ENDPOINT format: ${apiBaseUrl}`, urlError); // Keep error
        return new Response(JSON.stringify({ error: 'Server configuration error: Invalid API Endpoint URL format.', details: urlError.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // --- 状态机处理逻辑 ---
    let systemPrompt = baseSystemPrompt;
    let messages = [];
    let aiReply = "";
    let stateChanged = false;
    
    // 初始化消息数组，始终包含系统提示
    messages.push({ role: "system", content: systemPrompt });
    
    // 添加相关的对话历史记录到消息数组
    // 确保 conversation_history 存在
    if (!currentState.conversation_history) {
      currentState.conversation_history = [];
    }
    
    // 根据当前状态处理用户输入
    switch (currentState.status) {
      case 'AWAITING_INITIAL_INPUT':
        // 保存用户的初始需求
        currentState.initial_requirements = userMessage;
        currentState.status = 'GENERATING_OUTLINE';
        stateChanged = true;
        
        // 构建生成大纲的提示
        systemPrompt = "你是一个AI助手，负责根据用户需求生成详细的内容大纲。请以Markdown格式输出大纲，使用多级列表结构。";
        messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: `根据以下需求生成一个详细的内容大纲：\n\n${userMessage}` }
        ];
        break;
        
      case 'GENERATING_OUTLINE':
        // 这是一个中间状态，通常不会直接进入，但如果发生，我们可以提供反馈
        aiReply = "正在生成大纲，请稍候...";
        return new Response(JSON.stringify({ 
          reply: aiReply,
          state: { status: currentState.status }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        
      case 'AWAITING_OUTLINE_APPROVAL':
        // 处理用户对大纲的反馈
        const command = userMessage.trim().toUpperCase();
        
        if (command === 'C') { // 确认大纲
          currentState.approved_outline = currentState.outline;
          currentState.current_chapter_index = 0;
          currentState.status = 'GENERATING_CHAPTER';
          stateChanged = true;
          
          // 构建生成第一章内容的提示
          systemPrompt = "你是一个AI写作助手，负责根据已批准的大纲生成特定章节的内容。";
          
          // 添加相关历史记录：初始需求和大纲生成过程
          messages = [
            { role: "system", content: systemPrompt }
          ];
          
          // 添加初始需求和大纲相关的历史记录
          const relevantHistory = currentState.conversation_history.filter(msg => 
            msg.content.includes(currentState.initial_requirements) || 
            msg.content.includes(currentState.outline)
          );
          
          // 如果有相关历史，添加到消息中
          if (relevantHistory.length > 0) {
            messages = messages.concat(relevantHistory);
          }
          
          // 添加当前用户确认指令和生成章节的请求
          messages.push({ role: "user", content: `已批准的大纲如下：\n\`\`\`\n${currentState.approved_outline}\n\`\`\`\n\n请生成第 ${currentState.current_chapter_index + 1} 章的完整内容。` });
        } else { // 用户提供了修改建议，重新生成大纲
          // 将用户的反馈视为对大纲的修改建议
          currentState.status = 'GENERATING_OUTLINE';
          stateChanged = true;
          
          systemPrompt = "你是一个AI助手，负责根据用户的初始需求和修改建议生成改进的内容大纲。请以Markdown格式输出大纲。";
          
          // 添加相关历史记录：初始需求和大纲生成过程
          messages = [
            { role: "system", content: systemPrompt }
          ];
          
          // 查找初始需求和最近的大纲相关消息
          const outlineHistory = currentState.conversation_history.filter(msg => 
            msg.content.includes(currentState.initial_requirements) || 
            msg.content.includes(currentState.outline)
          );
          
          // 如果有相关历史，添加到消息中
          if (outlineHistory.length > 0) {
            messages = messages.concat(outlineHistory);
          }
          
          // 添加当前用户的修改建议
          messages.push({ role: "user", content: `初始需求：\n${currentState.initial_requirements}\n\n原始大纲：\n${currentState.outline}\n\n修改建议：\n${userMessage}\n\n请生成修改后的大纲。` });
        }
        break;
        
      case 'AWAITING_CHAPTER_FEEDBACK':
        // 处理用户对章节内容的反馈
        const chapterCommand = userMessage.trim().toUpperCase();
        
        if (chapterCommand === 'C') { // 确认章节
          // 保存当前章节
          if (!currentState.confirmed_chapters) {
            currentState.confirmed_chapters = [];
          }
          
          // 假设最后一次AI回复是当前章节内容
          if (currentState.last_chapter_content) {
            currentState.confirmed_chapters.push({
              index: currentState.current_chapter_index,
              content: currentState.last_chapter_content
            });
          }
          
          // 移至下一章
          currentState.current_chapter_index++;
          
          // 检查是否还有更多章节
          const outlineLines = currentState.approved_outline.split('\n').filter(line => line.trim().length > 0);
          const estimatedChapters = Math.max(outlineLines.length / 2, 3); // 粗略估计章节数
          
          if (currentState.current_chapter_index >= estimatedChapters) {
            // 所有章节已完成
            aiReply = "所有章节已完成！您可以开始新的项目。";
            currentState.status = 'COMPLETED';
            stateChanged = true;
            
            return new Response(JSON.stringify({ 
              reply: aiReply,
              state: { status: currentState.status },
              chapters: currentState.confirmed_chapters
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          } else {
            // 生成下一章
            currentState.status = 'GENERATING_CHAPTER';
            stateChanged = true;
            
            systemPrompt = "你是一个AI写作助手，负责根据已批准的大纲生成特定章节的内容。";
            
            // 构建消息数组，包含系统提示
            messages = [
              { role: "system", content: systemPrompt }
            ];
            
            // 添加大纲和前一章相关的历史记录
            const chapterHistory = currentState.conversation_history.filter(msg => 
              msg.content.includes(currentState.approved_outline) || 
              (currentState.confirmed_chapters.length > 0 && 
               msg.content.includes(currentState.confirmed_chapters[currentState.confirmed_chapters.length - 1].content))
            );
            
            // 如果有相关历史，添加到消息中
            if (chapterHistory.length > 0) {
              messages = messages.concat(chapterHistory.slice(-4)); // 只取最近的几条相关历史
            }
            
            // 添加当前用户确认指令和生成下一章的请求
            messages.push({ role: "user", content: `已批准的大纲如下：\n\`\`\`\n${currentState.approved_outline}\n\`\`\`\n\n请生成第 ${currentState.current_chapter_index + 1} 章的完整内容。` });
          }
        } else { // 用户提供了修改建议，重新生成当前章节
          // 将用户的反馈视为对当前章节的修改建议
          currentState.status = 'GENERATING_CHAPTER';
          stateChanged = true;
          
          systemPrompt = "你是一个AI写作助手，负责根据用户的修改建议调整章节内容。";
          
          // 构建消息数组，包含系统提示
          messages = [
            { role: "system", content: systemPrompt }
          ];
          
          // 添加大纲和当前章节相关的历史记录
          const chapterFeedbackHistory = currentState.conversation_history.filter(msg => 
            msg.content.includes(currentState.approved_outline) || 
            (currentState.last_chapter_content && msg.content.includes(currentState.last_chapter_content))
          );
          
          // 如果有相关历史，添加到消息中
          if (chapterFeedbackHistory.length > 0) {
            messages = messages.concat(chapterFeedbackHistory.slice(-4)); // 只取最近的几条相关历史
          }
          
          // 添加当前用户的修改建议
          messages.push({ role: "user", content: `大纲：\n${currentState.approved_outline}\n\n原始第${currentState.current_chapter_index + 1}章内容：\n${currentState.last_chapter_content || "无原始内容"}\n\n修改建议：\n${userMessage}\n\n请生成修改后的第${currentState.current_chapter_index + 1}章内容。` });
        }
        break;

      case 'GENERATING_CHAPTER':
        // 这是一个中间状态，通常不会直接进入
        aiReply = `正在生成第 ${currentState.current_chapter_index + 1} 章内容，请稍候...`;
        return new Response(JSON.stringify({ 
          reply: aiReply,
          state: { status: currentState.status }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        
      default:
        // 处理未知状态 - 重置到初始状态
        console.warn(`[handleChatRequest] Unknown state "${currentState.status}" for ${loginCode}, resetting.`);
        currentState = {
          status: 'AWAITING_INITIAL_INPUT',
          initial_requirements: null,
          outline: null,
          approved_outline: null,
          current_chapter_index: -1,
          confirmed_chapters: [],
          conversation_history: currentState.conversation_history || []
        };
        stateChanged = true;
        
        aiReply = "状态已重置。请提供您的需求。";
        return new Response(JSON.stringify({ 
          reply: aiReply,
          state: { status: currentState.status }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // --- 调用LLM API ---
    const llmRequestPayload = { model: modelName, messages: messages };
    
    const llmResponse = await fetch(fullApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(llmRequestPayload),
    });

    // --- Process LLM Response ---
    if (!llmResponse.ok) { // Handle non-2xx responses
        let errorText = `LLM API returned status ${llmResponse.status}`;
        try {
             const errorBody = await llmResponse.text();
             console.error(`[handleChatRequest] LLM API request failed body: ${errorBody}`); // Keep error log with body
             errorText = errorBody || errorText;
        } catch (e) { console.error("[handleChatRequest] Failed to read LLM error response body:", e); }
        // Return a structured error including details from the LLM API response
        return new Response(JSON.stringify({ error: 'Failed to get response from AI service.', llm_status: llmResponse.status, llm_details: errorText }), {
             status: 500, // Internal Server Error because *our* service couldn't fulfill the request via the upstream API
             headers: { 'Content-Type': 'application/json' }
         });
    }

    // --- Process OK response (2xx) ---
    let llmResult;
    try {
        llmResult = await llmResponse.json();
    } catch (jsonError) {
        console.error('[handleChatRequest] Failed to parse LLM JSON response:', jsonError); // Keep error
        // Attempt to log raw text if JSON parsing fails
        let rawText = "[Could not read raw text after JSON parse failure]";
        try { const responseClone = llmResponse.clone(); rawText = await responseClone.text(); console.error('[handleChatRequest] Raw response text:', rawText); } catch (textError) { /* ignore */ }
        return new Response(JSON.stringify({ error: 'Failed to parse AI response.', details: jsonError.message, raw_response: rawText }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // --- Extract reply ---
    aiReply = llmResult.choices?.[0]?.message?.content?.trim();
    // Add fallback for slightly different structures if necessary
     if (!aiReply) {
         aiReply = llmResult.response || llmResult.output || llmResult.text || llmResult.content;
         if (!aiReply && typeof llmResult === 'string') { aiReply = llmResult.trim(); }
     }

    if (!aiReply) {
        console.error('[handleChatRequest] Could not extract AI reply from parsed LLM response:', JSON.stringify(llmResult)); // Keep error
        return new Response(JSON.stringify({ error: 'Failed to parse AI response (content missing).', response_structure: JSON.stringify(llmResult) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // --- 更新状态 ---
    // 根据当前状态和LLM响应更新状态
    if (currentState.status === 'GENERATING_OUTLINE') {
      currentState.outline = aiReply;
      currentState.status = 'AWAITING_OUTLINE_APPROVAL';
      stateChanged = true;
      
      // 添加用户提示 - 简化为只有 'C' 命令
      aiReply = `${aiReply}\n\n请检查以上大纲并回复：\n- 输入 'C' 确认大纲\n- 或直接输入您的修改意见`;
    } else if (currentState.status === 'GENERATING_CHAPTER') {
      currentState.last_chapter_content = aiReply;
      currentState.status = 'AWAITING_CHAPTER_FEEDBACK';
      stateChanged = true;
      
      // 添加用户提示 - 简化为只有 'C' 命令
      aiReply = `${aiReply}\n\n请检查以上第 ${currentState.current_chapter_index + 1} 章内容并回复：\n- 输入 'C' 确认并继续下一章\n- 或直接输入您对本章的修改意见`;
    }
    
    // 记录对话历史
    if (!currentState.conversation_history) {
      currentState.conversation_history = [];
    }
    currentState.conversation_history.push({
      role: "user",
      content: userMessage
    });
    currentState.conversation_history.push({
      role: "assistant",
      content: aiReply
    });
    
    // 限制对话历史长度，防止KV值过大
    if (currentState.conversation_history.length > 20) {
      currentState.conversation_history = currentState.conversation_history.slice(-20);
    }
    
    // --- 持久化状态到KV ---
    if (stateChanged) {
      try {
        await env.KV_NAMESPACE.put(loginCode, JSON.stringify(currentState));
      } catch (kvError) {
        console.error(`[handleChatRequest] Failed to update state in KV for ${loginCode}:`, kvError);
        // 即使KV写入失败，我们仍然返回响应，但记录错误
      }
    }

    // --- 返回响应 ---
    return new Response(JSON.stringify({ 
      reply: aiReply,
      state: { 
        status: currentState.status,
        current_chapter_index: currentState.current_chapter_index
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[handleChatRequest] Unexpected error caught in try-catch block:', error); // Keep critical error
    return new Response(JSON.stringify({ error: 'Failed to process chat request.', details: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}


// {{ 编辑 2: 添加新的 handleResetRequest 函数 }}
/**
 * Handles the /api/reset POST request to reset user state in KV.
 * @param {Request} request
 * @param {object} env - Environment object with KV_NAMESPACE binding
 * @returns {Promise<Response>}
 */
async function handleResetRequest(request, env) {
  try {
    // --- Input Validation ---
    if (!request.headers.get('content-type')?.includes('application/json')) {
      return new Response(JSON.stringify({ error: 'Invalid request body type. Expected JSON.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    let body;
    try {
      body = await request.json();
    } catch (jsonError) {
      console.error('[handleResetRequest] Failed to parse request JSON body:', jsonError);
      return new Response(JSON.stringify({ error: 'Invalid JSON format in request body.', details: jsonError.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const loginCode = body.code;
    if (!loginCode) {
      return new Response(JSON.stringify({ error: 'Login code is required to reset state.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // --- KV Access and Validation ---
    if (!env.KV_NAMESPACE) {
      console.error("[handleResetRequest] KV_NAMESPACE binding is not configured.");
      return new Response(JSON.stringify({ error: 'Server configuration error: KV Namespace not bound.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // Verify the login code exists before resetting
    const kvValue = await env.KV_NAMESPACE.get(loginCode);
    if (kvValue === null) {
      console.warn(`[handleResetRequest] Attempt to reset state for non-existent code: ${loginCode}`);
      // 返回 404 或 401 都可以，取决于你想如何处理无效 code 的重置请求
      return new Response(JSON.stringify({ error: 'Cannot reset state for invalid or expired login code.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // --- Reset State ---
    try {
      const initialState = {
        status: 'AWAITING_INITIAL_INPUT',
        initial_requirements: null,
        outline: null,
        approved_outline: null,
        current_chapter_index: -1,
        confirmed_chapters: [],
        conversation_history: [] // 清空对话历史
      };
      await env.KV_NAMESPACE.put(loginCode, JSON.stringify(initialState));
      console.log(`[handleResetRequest] Successfully reset state for user ${loginCode}`);
      return new Response(JSON.stringify({ success: true, message: 'State reset successfully.' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (stateError) {
      console.error(`[handleResetRequest] CRITICAL: Failed to reset state for ${loginCode}! Error:`, stateError);
      return new Response(JSON.stringify({ error: 'Server error during state reset.', details: stateError.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

  } catch (error) {
    console.error('[handleResetRequest] Unexpected error caught:', error);
    return new Response(JSON.stringify({ error: 'Failed to process reset request.', details: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}


/**
 * Main Cloudflare Pages function handler for POST requests.
 * Routes requests based on URL path.
 * @param {object} context - The context object provided by Cloudflare Pages.
 * @returns {Promise<Response>}
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  console.log(`[onRequestPost] Received POST request for path: ${path}`); // Log path

  // {{ 编辑 3: 更新路由逻辑 }}
  try {
    if (path.startsWith('/api/login')) {
      console.log('[onRequestPost] Routing to handleLoginRequest');
      return await handleLoginRequest(request, env);
    } else if (path.startsWith('/api/chat')) {
      console.log('[onRequestPost] Routing to handleChatRequest');
      return await handleChatRequest(request, env);
    } else if (path.startsWith('/api/reset')) { // 新增的路由
       console.log('[onRequestPost] Routing to handleResetRequest');
       return await handleResetRequest(request, env);
    }
     else {
      console.warn(`[onRequestPost] Unhandled POST path: ${path}`);
      return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
    }
  } catch (e) {
     console.error(`[onRequestPost] Global error handler caught: ${e.message}`, e.stack);
     return new Response(JSON.stringify({ error: 'Internal Server Error', details: e.message }), {status: 500});
  }
}