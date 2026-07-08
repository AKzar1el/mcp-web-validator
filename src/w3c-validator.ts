export interface W3CMessage {
  type: string;
  lastLine?: number;
  lastColumn?: number;
  firstLine?: number;
  firstColumn?: number;
  message: string;
  extract?: string;
}

export interface CSSMessage {
  line: number;
  type: string;
  message: string;
  context?: string;
}

/**
 * Validates HTML using the W3C Nu HTML Checker API
 */
export async function validateHtmlContent(htmlContent: string): Promise<W3CMessage[]> {
  const url = "https://validator.w3.org/nu/?out=json";
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "User-Agent": "Mozilla/5.0 (MCP Web Validator)",
      },
      body: htmlContent,
    });

    if (!response.ok) {
      throw new Error(`W3C HTML validator returned HTTP status ${response.status}`);
    }

    const data = (await response.json()) as { messages?: W3CMessage[] };
    return data.messages || [];
  } catch (error: any) {
    throw new Error(`Failed to contact W3C HTML Validator: ${error.message}`);
  }
}

/**
 * Validates CSS using the W3C Jigsaw CSS Validator API
 */
export async function validateCssContent(cssContent: string): Promise<CSSMessage[]> {
  const url = "https://jigsaw.w3.org/css-validator/validator";
  
  try {
    const params = new URLSearchParams();
    params.append("text", cssContent);
    params.append("output", "json");
    params.append("warning", "0"); // Hide warnings to focus on errors
    params.append("profile", "css3svg");

    const response = await fetch(`${url}?${params.toString()}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (MCP Web Validator)",
      },
    });

    if (!response.ok) {
      throw new Error(`W3C CSS validator returned HTTP status ${response.status}`);
    }

    const text = await response.text();
    
    // W3C Jigsaw API sometimes returns invalid JSON or empty responses if there are network issues
    if (!text || text.trim() === "") {
      return [];
    }

    const data = JSON.parse(text) as {
      cssvalidation?: {
        errors?: Array<{
          line: number;
          message: string;
          context?: string;
          type?: string;
        }>;
        warnings?: Array<{
          line: number;
          message: string;
          context?: string;
          type?: string;
        }>;
      };
    };

    const errors = data.cssvalidation?.errors || [];
    return errors.map(err => ({
      line: err.line || 0,
      type: "error",
      message: err.message ? err.message.trim() : "Unknown CSS validation error",
      context: err.context || undefined
    }));
  } catch (error: any) {
    throw new Error(`Failed to contact W3C CSS Validator: ${error.message}`);
  }
}
