import express from "express";
import dotenv from "dotenv";
import { getHttpEndpoint } from "@orbs-network/ton-access";
import TonWeb from "tonweb";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.get("/check-task/", async (req, res) => {
  const { address, time } = req.query;
  if (!address || !time) {
    res.status(400).json({ error: "need time & address" });
    return;
  }
  try {
    const timeInt = parseInt(time as string);
    const endpoint = await getHttpEndpoint();
    const tonweb = new TonWeb(new TonWeb.HttpProvider(endpoint));
    const transactions = await tonweb.getTransactions(address as string, 1);
    if (transactions.length === 0) {
      res.json({ status: "waiting" });
      return;
    }

    const transaction = transactions[0];
    const transactionTime = transaction.utime;
    console.log(transactionTime);
    if (transactionTime > timeInt) {
      res.json({ status: "done" });
      return;
    }
    res.json({ status: "waiting" });
  } catch (e) {
    res.status(400).json({ status: "error", message: "address isn't valid" });
  }
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});
