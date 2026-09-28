export interface DetailInquiryRequest {
  assistantId: string;
  chatId: string;
  messageId: string;
  quote: string;
  providerId?: string | null;
  modelId?: string | null;
}

const listeners = new Set<(request: DetailInquiryRequest) => void>();

export function requestDetailInquiry(request: DetailInquiryRequest): void {
  listeners.forEach((listener) => listener(request));
}

export function subscribeDetailInquiry(
  listener: (request: DetailInquiryRequest) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
