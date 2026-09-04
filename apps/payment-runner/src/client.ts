export type ClaimedJob = {
  job_id: string;
  payment_attempt_id: string;
  executor_token: string;
  razorpay_order_id: string;
  razorpay_key_id: string;
  amount_minor: string;
  currency: string;
  scenario: string;
  checkout_page_url?: string;
  callback_origin?: string;
};

export class RunnerClient {
  constructor(
    private readonly endpoint: string,
    private readonly credential: string,
  ) {}

  async claim(): Promise<ClaimedJob | null> {
    const res = await fetch(`${this.endpoint}/internal/v1/test-runner/jobs/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.credential}` },
    });
    if (res.status === 204) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`claim failed ${res.status}`);
    }
    return (await res.json()) as ClaimedJob;
  }

  async observe(jobId: string, token: string, screen: string): Promise<void> {
    const res = await fetch(`${this.endpoint}/internal/v1/test-runner/jobs/${jobId}/observations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        executor_token: token,
        observed_screen: screen,
        not_capture: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`observe failed ${res.status}`);
    }
  }
}
