# FundMe-style chipnet pilot

This is a representative local integration for a BCH crowdfunding frontend.
It is not FundMe production code and is not an endorsement by FundMe or its
developers.

The pilot proves a narrow browser use case:

- connect to checkpoint-verified chipnet WSS endpoints;
- display a campaign address's current balance and goal progress;
- receive an address status trigger;
- fail over and restore the subscription;
- refresh the displayed snapshot on the replacement server.

It deliberately contains no pledge, claim, refund, signing, wallet, or payout
action. Browser balance and height values are one active server's claims. They
must not authorize a financial decision. A real application should send the
change signal to a backend that re-queries through cascan's strict Node quorum
before it marks a pledge paid, releases funds, or changes contract state.

Run it from a reviewed checkout:

```sh
npm run serve:browser
# open http://127.0.0.1:4173/examples/fundme-pilot/
```

The form is fixed to `network: 'chipnet'`. Leave the WSS override blank to use
cascan's bootstrap pool, or enter reviewed chipnet `wss://` endpoints. Each
selected server can observe the user's IP address and queried campaign address.

Automated acceptance coverage uses local deterministic Fulcrum fixtures in
Chromium, Firefox, and WebKit. The fixtures prove checkpoint setup, campaign
math, subscription activation, failover, and display refresh. A later private
pilot inside a real FundMe-style staging frontend is still required before
claiming integration compatibility.
