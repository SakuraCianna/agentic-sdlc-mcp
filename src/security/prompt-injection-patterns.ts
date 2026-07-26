export type PromptInjectionCategory =
  | "instruction_override"
  | "role_impersonation"
  | "tool_coercion"
  | "secret_exfiltration"
  | "data_exfiltration"
  | "encoded_instruction";

export interface PromptInjectionAssessment {
  detected: boolean;
  severity: "none" | "medium" | "high";
  categories: PromptInjectionCategory[];
}

const SIGNALS: ReadonlyArray<{
  category: PromptInjectionCategory;
  pattern: RegExp;
}> = [
  {
    category: "instruction_override",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:previous|prior|system|developer)\b.{0,40}\b(?:instructions?|messages?|rules?|prompts?)\b/is,
  },
  {
    category: "instruction_override",
    pattern:
      /(?:忽略|无视|忘记|覆盖).{0,40}(?:之前|先前|系统|开发者).{0,30}(?:指令|消息|规则|提示词)/is,
  },
  {
    category: "role_impersonation",
    pattern: /\b(?:system|developer)\s+(?:message|prompt|instructions?)\s*:/is,
  },
  {
    category: "role_impersonation",
    pattern: /(?:系统|开发者)(?:消息|提示词|指令)\s*[:：]/is,
  },
  {
    category: "tool_coercion",
    pattern:
      /\b(?:call|invoke|execute|run|use)\b.{0,50}\b(?:tool|shell|powershell|bash|terminal|create_issue_set)\b.{0,80}\b(?:without|bypass|ignore|do not ask|no confirmation)\b/is,
  },
  {
    category: "tool_coercion",
    pattern:
      /(?:调用|执行|运行|使用).{0,40}(?:工具|shell|powershell|bash|终端).{0,50}(?:无需|绕过|忽略|不要询问|不经确认)/is,
  },
  {
    category: "secret_exfiltration",
    pattern:
      /\b(?:print|show|reveal|return|send|upload|exfiltrate|read)\b.{0,80}\b(?:github[_ -]?token|api[_ -]?key|access[_ -]?token|cookie|private[_ -]?key|password|environment\s+variable|process\.env)\b/is,
  },
  {
    category: "secret_exfiltration",
    pattern:
      /(?:打印|显示|泄露|返回|发送|上传|外传|读取).{0,50}(?:github[_ -]?token|api[_ -]?key|access[_ -]?token|cookie|私钥|密码|环境变量|令牌|密钥)/is,
  },
  {
    category: "data_exfiltration",
    pattern:
      /\b(?:send|upload|post|transmit|exfiltrate)\b.{0,100}\b(?:repository|source\s+code|file\s+contents?|workspace|private\s+data|secrets?)\b.{0,100}\b(?:https?:\/\/|webhook|external|remote)\b/is,
  },
  {
    category: "data_exfiltration",
    pattern:
      /(?:(?:发送|上传|外传).{0,60}(?:仓库|源代码|文件内容|工作区|敏感数据|密钥)|(?:仓库|源代码|文件内容|工作区|敏感数据|密钥).{0,60}(?:发送|上传|外传)).{0,80}(?:https?:\/\/|webhook|外部|远程)/is,
  },
  {
    category: "encoded_instruction",
    pattern:
      /\b(?:decode|decrypt|base64|rot13|encoded)\b.{0,100}\b(?:execute|run|follow|obey|instructions?|commands?)\b|\b(?:execute|run|follow|obey)\b.{0,100}\b(?:base64|rot13|encoded)\b/is,
  },
  {
    category: "encoded_instruction",
    pattern:
      /(?:解码|base64|rot13|编码).{0,80}(?:执行|运行|遵循|服从|指令|命令)|(?:执行|运行|遵循|服从).{0,80}(?:base64|rot13|编码)/is,
  },
];

function canonicalize(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
}

/** Deterministically identify high-confidence instruction-like content. */
export function assessPromptInjection(value: string): PromptInjectionAssessment {
  const canonical = canonicalize(value);
  const categories = SIGNALS.filter(({ pattern }) => pattern.test(canonical)).map(
    ({ category }) => category
  );
  const uniqueCategories = [...new Set(categories)];
  const highConfidence =
    uniqueCategories.includes("instruction_override") ||
    uniqueCategories.includes("secret_exfiltration") ||
    uniqueCategories.includes("data_exfiltration") ||
    uniqueCategories.includes("encoded_instruction") ||
    uniqueCategories.length > 1;

  return {
    detected: uniqueCategories.length > 0,
    severity: highConfidence ? "high" : uniqueCategories.length > 0 ? "medium" : "none",
    categories: uniqueCategories,
  };
}
