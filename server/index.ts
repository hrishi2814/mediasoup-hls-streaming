const express = require('express');
import type { Request, Response } from "express";

const app = express();
const port = 3003;
// const server = http.createServer(app);

app.get('/', (req: Request, res: Response) => {
    res.send('set up backend servereajsijdaj')
});

app.listen(port, ()=>{
    console.log('listening on 3003');
} )
