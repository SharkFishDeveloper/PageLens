"use client";

import { Book } from "@/interface";
import { getDB } from "@/lib/idb";
import { useState } from "react";

type UploadBookProps = {
    allBooks: Book[],
    setAllBooks: (
        value: Book[] | ((books: Book[]) => Book[])
    ) => void;
};

const UploadBook = ({ allBooks, setAllBooks }: UploadBookProps) => {
    const [error, setError] = useState<string | null>(null)


    const handleUpload = async (
        event: React.ChangeEvent<HTMLInputElement>
    ) => {
        const file = event.target.files?.[0];

        if (!file) return;

        if (file.type !== "application/pdf") {
            setError("Please select a PDF file");
            return;
        }

        // Only allow PDFs
        if (file.type !== "application/pdf") {
            alert("Please select a PDF file");
            return;
        }

        const bookExist = allBooks.some((book) => {
            book.name === file.name
        })

        const db = await getDB();

        const bookObject = {
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type,
            size: file.size,
            file: file,
            uploadedAt: Date.now(),
        }

        await db.put("books", bookObject);

        setAllBooks((books) => [...books, bookObject])

        alert("Book uploaded successfully!");
    };

    return (
        <div className="flex justify-center">
            <input
                type="file"
                accept="application/pdf"
                onChange={handleUpload}
            />
            {error && (
                <p className="text-red-500">
                    {error}
                </p>
            )}
        </div>
    );
};

export default UploadBook;