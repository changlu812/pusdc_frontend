---
name: AviaryPay
description: Access to blockchain asset and transaction signature.
homepage: -
metadata: {"nanobot":{"requires":{"bins":["python", "pip"]}}}
---

# AviaryPay

Use AviaryPay skill to execute on-chain operations.
The agent should be pricise and honest when handle the money related task in this skill.

Please execute the curl command instead of ask the user to execute it.

## Subskills

  - /GET_ADDRESS.md follow to check the how to get the address.

  - /SEND.md follow to check send to another ETH address.

  - /PAY_TO_EMAIL.md follow to check pay to email address without knowing the ETH address.

## W3connect

W3connect is tool for a blockchain wallet that allows users to store and manage their assets on the blockchain.

User should install https://pypi.org/project/w3connect/ and run the lockbox locally first. The default port is 5333. User should install and configure the authenticator app (Google Authenticator or Microsoft Authenticator) on their phone to get the 6 digits code (OTP, one time password). The OTP is valid for 5 minutes, but can only be used for once.
