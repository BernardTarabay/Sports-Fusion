// The login code must never leave the server outside development.
//
// THE BUG THIS EXISTS TO PREVENT
//
// `OTP_PROVIDER` defaults to 'log', which writes the six-digit code to the server log and
// returns it in the HTTP response so that local development works with no WhatsApp
// account. That is correct on a laptop and is total account takeover anywhere else:
// anyone who knows a phone number -- and this community's numbers are all in one WhatsApp
// group -- asks POST /api/auth/phone/start for its login code and is handed it, then
// signs in as that person. Including the owner.
//
// It was not an unlikely misconfiguration. render.yaml sets WHATSAPP_ENABLED=false and
// nothing else, which is exactly the state that selects 'log', so the DEPLOYED
// configuration had it.
//
// The gate is on NODE_ENV rather than on the provider, because "no provider is set" is
// precisely the condition a half-configured deploy is in. These tests exercise the pure
// decision function so they can assert the production branch without a second server.

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The rule, extracted exactly as config/index.js computes it.
 *
 * Duplicated rather than imported because config validates and freezes at module load
 * from a single process.env, so it cannot be asked about a different environment. If the
 * two ever drift, `the shipped configuration agrees with this rule` below fails.
 */
const decide = ({ nodeEnv, otpProvider, whatsappEnabled }) => {
  const provider = otpProvider ?? (whatsappEnabled ? 'whatsapp' : 'log');
  return {
    provider,
    canDeliver: provider !== 'log',
    exposeCode: provider === 'log' && nodeEnv !== 'production',
    channel: provider === 'twilio' ? 'sms' : provider === 'whatsapp' ? 'whatsapp' : null,
  };
};

test('a production deploy with no provider configured never exposes the code', () => {
  // The exact shape of render.yaml today: WHATSAPP_ENABLED=false, no OTP_PROVIDER.
  const deployed = decide({ nodeEnv: 'production', whatsappEnabled: false });

  assert.equal(deployed.provider, 'log', 'this is the configuration that ships');
  assert.equal(deployed.exposeCode, false, 'the code must never go out in a response');
  assert.equal(deployed.canDeliver, false, 'and it cannot reach a phone either');
});

test('no production configuration exposes the code, whatever the provider', () => {
  for (const otpProvider of [undefined, 'log', 'whatsapp', 'twilio']) {
    for (const whatsappEnabled of [true, false]) {
      const decision = decide({ nodeEnv: 'production', otpProvider, whatsappEnabled });
      assert.equal(
        decision.exposeCode, false,
        `exposeCode was true in production for provider=${otpProvider} whatsapp=${whatsappEnabled}`
      );
    }
  }
});

test('development still gets the code back, or nobody can sign in locally', () => {
  const local = decide({ nodeEnv: 'development', whatsappEnabled: false });
  assert.equal(local.exposeCode, true);

  const testing = decide({ nodeEnv: 'test', whatsappEnabled: false });
  assert.equal(testing.exposeCode, true);
});

test('a configured provider never returns the code, even in development', () => {
  // The code is going to a real phone. Returning it as well would make the message
  // decorative and the endpoint an oracle.
  for (const nodeEnv of ['development', 'test', 'production']) {
    assert.equal(decide({ nodeEnv, otpProvider: 'whatsapp' }).exposeCode, false);
    assert.equal(decide({ nodeEnv, otpProvider: 'twilio' }).exposeCode, false);
  }
});

test('the shipped configuration agrees with this rule', async () => {
  // Guards against the two drifting. NODE_ENV is 'test' under the runner, so this
  // asserts the development branch; the production branch is covered above.
  const { default: config } = await import('./config/index.js');
  const expected = decide({
    nodeEnv: process.env.NODE_ENV,
    otpProvider: process.env.OTP_PROVIDER,
    whatsappEnabled: process.env.WHATSAPP_ENABLED === 'true',
  });

  assert.equal(config.otp.provider, expected.provider);
  assert.equal(config.otp.exposeCode, expected.exposeCode);
  assert.equal(config.otp.canDeliver, expected.canDeliver);
  assert.equal(config.otp.channel, expected.channel);
});

// ---------------------------------------------------------------------------
// Which app the code is in
//
// The sign-in screen used to say "Check WhatsApp for a six digit code" whatever the
// provider was. Under Twilio that sends somebody to a WhatsApp thread to wait for an
// SMS, which is a dead end they cannot reason their way out of -- so the server names
// the channel and the screen repeats it.
// ---------------------------------------------------------------------------

test('the channel names where the code actually went', () => {
  assert.equal(decide({ nodeEnv: 'production', otpProvider: 'twilio' }).channel, 'sms');
  assert.equal(decide({ nodeEnv: 'production', otpProvider: 'whatsapp' }).channel, 'whatsapp');
  assert.equal(decide({ nodeEnv: 'production', whatsappEnabled: true }).channel, 'whatsapp');
  assert.equal(
    decide({ nodeEnv: 'production', whatsappEnabled: false }).channel, null,
    'with no provider there is no channel to name'
  );
});

test('naming the channel never implies the code is safe to expose', () => {
  // The channel is a deployment fact and goes on the wire; the code is a secret and
  // does not. Nothing about adding the first may loosen the second.
  for (const otpProvider of ['log', 'whatsapp', 'twilio']) {
    const production = decide({ nodeEnv: 'production', otpProvider });
    assert.equal(production.exposeCode, false, `provider=${otpProvider}`);
  }
  assert.equal(
    decide({ nodeEnv: 'development', otpProvider: 'twilio' }).exposeCode, false,
    'a real provider withholds the code even on a laptop -- it was genuinely sent'
  );
});
