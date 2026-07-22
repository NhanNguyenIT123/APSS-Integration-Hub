codeunit 70303 "APSS Middleware Sync"
{
    TableNo = "APSS RFQ Buffer";

    trigger OnRun()
    begin
        PullRfqAndDraftQuote(Rec."RFQ No.");
    end;

    procedure FetchRfqList()
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        ResponseText: Text;
        JToken: JsonToken;
        JObject: JsonObject;
        JArray: JsonArray;
        RfqArrayToken: JsonToken;
        RfqToken: JsonToken;
        RfqObj: JsonObject;
        RfqBuffer: Record "APSS RFQ Buffer";
        TempRfqBuffer: Record "APSS RFQ Buffer" temporary;
        Opportunity: Record Opportunity;
        SalesHeader: Record "Sales Header";
        i: Integer;
        Url: Text;
    begin
        Setup.GetSetupRecord();
        
        if Setup."Middleware Base URL" = '' then
            Error('Middleware Base URL is not configured in APSS Integration Setup.');
        
        Url := Setup."Middleware Base URL" + '/api/middleware/list';
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', '1');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
        
        if not Client.Get(Url, Response) then
            Error('Failed to connect to APSS Integration Hub at %1', Url);
            
        if not Response.IsSuccessStatusCode() then
            Error('Error response from Middleware: %1 %2', Response.HttpStatusCode(), Response.ReasonPhrase());
            
        Response.Content().ReadAs(ResponseText);
        
        if not JToken.ReadFrom(ResponseText) then
            Error('Invalid response JSON format from Middleware.');
            
        JObject := JToken.AsObject();
        if not JObject.Get('rfq_list', RfqArrayToken) then
            exit; // No RFQs
            
        JArray := RfqArrayToken.AsArray();
        
        for i := 0 to JArray.Count() - 1 do begin
            JArray.Get(i, RfqToken);
            RfqObj := RfqToken.AsObject();
            
            RfqBuffer.Init();
            RfqBuffer."RFQ No." := CopyStr(GetJsonValueAsText(RfqObj, 'rfq_no'), 1, 50);
            RfqBuffer.Subject := CopyStr(GetJsonValueAsText(RfqObj, 'subject'), 1, 250);
            RfqBuffer.Drafter := CopyStr(GetJsonValueAsText(RfqObj, 'drafter'), 1, 100);
            RfqBuffer."Register Date" := CopyStr(GetJsonValueAsText(RfqObj, 'date'), 1, 50);
            RfqBuffer."Close Date" := CopyStr(GetJsonValueAsText(RfqObj, 'close_date'), 1, 50);
            RfqBuffer.Portal := CopyStr(GetJsonValueAsText(RfqObj, 'portal'), 1, 50);
            RfqBuffer."Item Count" := GetJsonValueAsInteger(RfqObj, 'item_count');
            
            // Check if Sales Quote already exists in database to auto-populate Sales Quote Created
            SalesHeader.Reset();
            SalesHeader.SetRange("Document Type", SalesHeader."Document Type"::Quote);
            SalesHeader.SetRange("External Document No.", RfqBuffer."RFQ No.");
            if SalesHeader.FindFirst() then
                RfqBuffer."Sales Quote Created" := SalesHeader."No."
            else
                RfqBuffer."Sales Quote Created" := '';

            if not RfqBuffer.Insert() then
                RfqBuffer.Modify();
                
            TempRfqBuffer.Init();
            TempRfqBuffer."RFQ No." := RfqBuffer."RFQ No.";
            TempRfqBuffer.Insert();
        end;

        // Clean up any obsolete/deleted RFQs from the database without clearing everything
        RfqBuffer.Reset();
        if RfqBuffer.FindSet() then begin
            repeat
                if not TempRfqBuffer.Get(RfqBuffer."RFQ No.") then
                    RfqBuffer.Delete();
            until RfqBuffer.Next() = 0;
        end;
    end;

    procedure PullRfqAndDraftQuote(RfqNo: Code[50])
    var
        Setup: Record "APSS Integration Setup";
        RfqBuffer: Record "APSS RFQ Buffer";
        Client: HttpClient;
        Response: HttpResponseMessage;
        ResponseText: Text;
        JToken: JsonToken;
        JObject: JsonObject;
        ItemsToken: JsonToken;
        ItemsArray: JsonArray;
        ItemToken: JsonToken;
        ItemObj: JsonObject;
        i: Integer;
        Url: Text;
        
        // BC Records
        SalesHeader: Record "Sales Header";
        SalesLine: Record "Sales Line";
        Item: Record "Item";
        Customer: Record Customer;
        Opportunity: Record Opportunity;
        Contact: Record Contact;
        ContBusRel: Record "Contact Business Relation";
        MarketingSetup: Record "Marketing Setup";
        OppEntry: Record "Opportunity Entry";
        ShipToAddr: Record "Ship-to Address";
        
        // Variables
        MatDesc: Text[100];
        UomCode: Code[10];
        QtyText: Text;
        QtyDec: Decimal;
        LineNo: Integer;
        ItemsCreated: Integer;
        ItemsLinked: Integer;
        CreatedQuoteNo: Code[20];
        CustomerNoToUse: Code[20];
        BrandText: Text;
        PartNoText: Text;
        MatchedItemNo: Code[20];
        LongDescText: Text;
        CustLineNoText: Text;
        CustLineNo: Integer;
        LeadTimeText: Text;
        LeadTimeWeeks: Integer;
        ParsedDate: Date;
        IsNewItem: Boolean;

        // Variables for Attachments
        RfqToken: JsonToken;
        RfqObj: JsonObject;
        AttachmentsToken: JsonToken;
        AttachmentsArray: JsonArray;
        AttachmentToken: JsonToken;
        AttachmentObj: JsonObject;
        AttName: Text;
        AttUrl: Text;
        AttClient: HttpClient;
        AttResponse: HttpResponseMessage;
        AttInStr: InStream;
        DocAttachment: Record "Document Attachment";
    begin
        Setup.GetSetupRecord();
            
        if Setup."Default Customer No." = '' then
            Error('Please configure a Default Customer No. in APSS Integration Setup.');
            
        Url := Setup."Middleware Base URL" + '/api/middleware/pull?rfq_no=' + RfqNo;
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', '1');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
        
        if not Client.Get(Url, Response) then
            Error('Failed to connect to Middleware at %1', Url);
            
        if not Response.IsSuccessStatusCode() then
            Error('Error response from Middleware: %1 %2', Response.HttpStatusCode(), Response.ReasonPhrase());
            
        Response.Content().ReadAs(ResponseText);
        
        if not JToken.ReadFrom(ResponseText) then
            Error('Invalid response JSON format from Middleware.');
            
        JObject := JToken.AsObject();
        if not JObject.Get('items', ItemsToken) then
            Error('No items found in response for RFQ %1', RfqNo);
            
        ItemsArray := ItemsToken.AsArray();
        if ItemsArray.Count() = 0 then
            Error('Items list is empty for RFQ %1', RfqNo);
            
        // Dynamic Customer Resolution based on Portal
        CustomerNoToUse := Setup."Default Customer No.";
        if RfqBuffer.Get(RfqNo) then begin
            if RfqBuffer.Portal = 'POSCO e-Pro' then begin
                Customer.Reset();
                Customer.SetFilter(Name, '@*POSCO*');
                if Customer.FindFirst() then
                    CustomerNoToUse := Customer."No.";
            end else if RfqBuffer.Portal = 'PTTEP FlashBuy' then begin
                Customer.Reset();
                Customer.SetFilter(Name, '@*PTTEP Energy*');
                if not Customer.FindFirst() then begin
                    Customer.SetFilter(Name, '@*PTTEP*');
                    Customer.FindFirst();
                end;
                CustomerNoToUse := Customer."No.";
            end;
        end;

        // Check if Sales Quote with this RFQ No. already exists to prevent duplicate import
        SalesHeader.Reset();
        SalesHeader.SetRange("Document Type", SalesHeader."Document Type"::Quote);
        SalesHeader.SetRange("External Document No.", RfqNo);
        if SalesHeader.FindFirst() then begin
            DocAttachment.Reset();
            DocAttachment.SetRange("Table ID", Database::"Sales Header");
            DocAttachment.SetRange("Document Type", SalesHeader."Document Type");
            DocAttachment.SetRange("No.", SalesHeader."No.");
            if DocAttachment.FindSet() then
                DocAttachment.DeleteAll(false);

            SalesHeader."Opportunity No." := '';
            SalesHeader.Delete(false);
        end;

        // Auto-create Opportunity (CRM compliant flow)
        Opportunity.Init();
        Opportunity.Validate(Description, CopyStr(RfqBuffer.Subject, 1, MaxStrLen(Opportunity.Description)));
        
        // Find and link Customer Contact if available to comply with standard CRM cycle
        ContBusRel.Reset();
        ContBusRel.SetRange("Link to Table", ContBusRel."Link to Table"::Customer);
        ContBusRel.SetRange("No.", CustomerNoToUse);
        if ContBusRel.FindFirst() then begin
            Opportunity.Validate("Contact Company No.", ContBusRel."Contact No.");
            // Find a person contact under the company contact if possible, otherwise use the company contact
            Contact.Reset();
            Contact.SetRange("Company No.", ContBusRel."Contact No.");
            Contact.SetRange(Type, Contact.Type::Person);
            if Contact.FindFirst() then
                Opportunity.Validate("Contact No.", Contact."No.")
            else
                Opportunity.Validate("Contact No.", ContBusRel."Contact No.");
        end;

        // Populate Sales Cycle Code from Marketing Setup
        if MarketingSetup.Get() then begin
            if MarketingSetup."Default Sales Cycle Code" <> '' then
                Opportunity.Validate("Sales Cycle Code", MarketingSetup."Default Sales Cycle Code");
        end;

        Opportunity.Insert(true);

        // Standard BC activation of first stage to change stage state
        if Opportunity."Sales Cycle Code" <> '' then begin
            OppEntry.Init();
            OppEntry."Entry No." := GetNextOppEntryNo();
            OppEntry."Opportunity No." := Opportunity."No.";
            OppEntry."Sales Cycle Code" := Opportunity."Sales Cycle Code";
            OppEntry."Sales Cycle Stage" := 1;
            OppEntry.Active := true;
            OppEntry."Date of Change" := Today();
            OppEntry."Estimated Close Date" := Today();
            OppEntry.Insert(true);
        end;

        Opportunity.Status := Opportunity.Status::"In Progress";
        Opportunity.Modify(true);

        // Create Sales Header (Draft Sales Quote)
        SalesHeader.Init();
        SalesHeader.SetHideValidationDialog(true);
        SalesHeader.Validate("Document Type", SalesHeader."Document Type"::Quote);
        SalesHeader.Insert(true); // Auto-generates Document No.
        SalesHeader.Validate("Sell-to Customer No.", CustomerNoToUse);

        // Clear Ship-to Code if it no longer exists in Ship-to Address table
        // (prevents BC validation crash when customer's default Ship-to Address was deleted)
        if SalesHeader."Ship-to Code" <> '' then begin
            ShipToAddr.Reset();
            ShipToAddr.SetRange("Customer No.", CustomerNoToUse);
            ShipToAddr.SetRange(Code, SalesHeader."Ship-to Code");
            if not ShipToAddr.FindFirst() then
                SalesHeader."Ship-to Code" := '';
        end;

        SalesHeader.Validate("Salesperson Code", ''); // Leave blank per feedback
        SalesHeader."Opportunity No." := Opportunity."No."; // Assign directly to bypass standard lookup error before transaction end
        SalesHeader.Validate("External Document No.", CopyStr(RfqNo, 1, MaxStrLen(SalesHeader."External Document No.")));
        SalesHeader.Validate("Your Reference", CopyStr(Opportunity.Description, 1, MaxStrLen(SalesHeader."Your Reference")));
        
        // Parse and Validate Requested Delivery Date from Close Date (prevent past shipment dates and warnings)
        if RfqBuffer.Get(RfqNo) then begin
            if RfqBuffer.Subject <> '' then
                SalesHeader.SetWorkDescription(RfqBuffer.Subject);
            if RfqBuffer."Close Date" <> '' then begin
                ParsedDate := ParseDateText(RfqBuffer."Close Date");
                if ParsedDate < WorkDate() then
                    ParsedDate := WorkDate();
                if ParsedDate < Today() then
                    ParsedDate := Today();
                SalesHeader.Validate("Requested Delivery Date", ParsedDate);
            end;
        end;
        
        AssignSalesHeaderCustomFields(SalesHeader);
        SalesHeader.Modify(true);
        CreatedQuoteNo := SalesHeader."No.";

        // Link the Sales Quote back to the Opportunity (Required for CRM link integrity)
        Opportunity.Validate("Sales Document Type", Opportunity."Sales Document Type"::Quote);
        Opportunity.Validate("Sales Document No.", CreatedQuoteNo);
        Opportunity.Modify(true);
        
        LineNo := 10000;
        ItemsCreated := 0;
        ItemsLinked := 0;
        
        for i := 0 to ItemsArray.Count() - 1 do begin
            ItemsArray.Get(i, ItemToken);
            ItemObj := ItemToken.AsObject();
            
            MatDesc := CopyStr(GetJsonValueAsText(ItemObj, 'description'), 1, 100);
            UomCode := CleanUomCode(GetJsonValueAsText(ItemObj, 'uom'));
            QtyText := GetJsonValueAsText(ItemObj, 'qty');
            BrandText := GetJsonValueAsText(ItemObj, 'manufacturer');
            PartNoText := GetJsonValueAsText(ItemObj, 'part_number');
            
            LongDescText := GetJsonValueAsText(ItemObj, 'long_description');
            if LongDescText = '' then
                LongDescText := GetJsonValueAsText(ItemObj, 'description');
            
            CustLineNoText := GetJsonValueAsText(ItemObj, 'item_no');
            if not Evaluate(CustLineNo, CustLineNoText) then
                CustLineNo := 0;
                
            LeadTimeText := GetJsonValueAsText(ItemObj, 'lead_time');
            if not Evaluate(LeadTimeWeeks, LeadTimeText) then
                LeadTimeWeeks := 0;
            
            QtyDec := ParseQtyTextToDecimal(QtyText);
            if QtyDec <= 0 then
                QtyDec := 1;
                  
            MatchedItemNo := CopyStr(GetJsonValueAsText(ItemObj, 'bc_item_no'), 1, 20);
            IsNewItem := false;
            
            // Check if item exists by matched item no or via robust local matching logic
            Item.Reset();
            if (MatchedItemNo <> '') and Item.Get(MatchedItemNo) then begin
                ItemsLinked += 1;
            end else if FindExistingItem(PartNoText, MatDesc, Item) then begin
                ItemsLinked += 1;
            end else begin
                // Create a new blank card and insert it first to enable child table relations
                Item.Init();
                Item."No." := GetNewItemNo();
                IsNewItem := true;
                AssignDefaultCustomFields(Item, BrandText, LongDescText);
                Item.Insert(true);
                
                Item.Validate(Description, MatDesc);
                EnsureUnitOfMeasure(UomCode);
                EnsureItemUnitOfMeasure(Item."No.", UomCode);
                Item.Validate("Base Unit of Measure", UomCode);
                AssignDefaultPostingGroups(Item, CustomerNoToUse);
                
                ItemsCreated += 1;
            end;
            
            // Always ensure the item is unblocked, and custom fields are populated/updated
            Item.Validate(Blocked, false);
            AssignDefaultCustomFields(Item, BrandText, LongDescText);
            
            if Item."Item Category Code" <> '' then begin
                CopyDefaultDimensionsFromItemCategory(Item, Item."Item Category Code");
            end;
            
            Item.Modify(true);
            
            if IsNewItem then
                SetItemApprovedDirectly(Item, false);
            
            // Ensure Item Reference entry is registered for the customer and general fallback
            if PartNoText <> '' then begin
                EnsureItemReference(Item."No.", PartNoText, BrandText, UomCode, CustomerNoToUse);
            end;
            
            // Add to Sales Line
            SalesLine.Init();
            SalesLine.Validate("Document Type", SalesLine."Document Type"::Quote);
            SalesLine.Validate("Document No.", CreatedQuoteNo);
            SalesLine.Validate("Line No.", LineNo);
            SalesLine.Validate(Type, SalesLine.Type::Item);
            SalesLine.Validate("No.", Item."No.");
            if PartNoText <> '' then begin
                SalesLine.Validate("Item Reference No.", CopyStr(PartNoText, 1, 50));
            end;
            SalesLine.Validate(Quantity, QtyDec);
            SalesLine.Insert(true);
            
            PopulateSalesLineCustomFields(SalesLine, BrandText, PartNoText, LongDescText, LeadTimeWeeks, CustLineNo);
            ApplyPopupEquivalentSalesLineFields(SalesLine, PartNoText, LongDescText, UomCode);
            SalesLine.Modify(false);
            
            PopulateItemRefContact(SalesLine, PartNoText, BrandText, LongDescText, CustLineNo, LeadTimeWeeks);
            
            LineNo += 10000;
        end;
        
        // ─── Attach RFQ Documents (Header Level) ─────────────────
        if JObject.Get('rfq', RfqToken) then begin
            RfqObj := RfqToken.AsObject();
            if RfqObj.Get('attachments', AttachmentsToken) then begin
                AttachmentsArray := AttachmentsToken.AsArray();
                for i := 0 to AttachmentsArray.Count() - 1 do begin
                    AttachmentsArray.Get(i, AttachmentToken);
                    AttachmentObj := AttachmentToken.AsObject();
                    AttName := GetJsonValueAsText(AttachmentObj, 'name');
                    AttUrl := GetJsonValueAsText(AttachmentObj, 'url');
                    
                    if (AttName <> '') and (AttUrl <> '') then begin
                        Clear(AttClient);
                        AttClient.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', '1');
                        if Setup."API Key" <> '' then
                            AttClient.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
                        if AttClient.Get(AttUrl, AttResponse) then begin
                            if AttResponse.IsSuccessStatusCode() then begin
                                AttResponse.Content().ReadAs(AttInStr);
                                
                                DocAttachment.Init();
                                DocAttachment.Validate("Table ID", Database::"Sales Header");
                                DocAttachment.Validate("Document Type", DocAttachment."Document Type"::Quote);
                                DocAttachment.Validate("No.", CreatedQuoteNo);
                                DocAttachment.Validate("Line No.", 0);
                                
                                DocAttachment.Reset();
                                DocAttachment.SetRange("Table ID", Database::"Sales Header");
                                DocAttachment.SetRange("Document Type", DocAttachment."Document Type"::Quote);
                                DocAttachment.SetRange("No.", CreatedQuoteNo);
                                DocAttachment.SetRange("Line No.", 0);
                                if DocAttachment.FindLast() then
                                    DocAttachment.ID := DocAttachment.ID + 1
                                else
                                    DocAttachment.ID := 1;
                                    
                                DocAttachment."File Name" := CopyStr(GetFileNameWithoutExtension(AttName), 1, MaxStrLen(DocAttachment."File Name"));
                                DocAttachment."File Extension" := CopyStr(GetFileExtension(AttName), 1, MaxStrLen(DocAttachment."File Extension"));
                                
                                if LowerCase(DocAttachment."File Extension") in ['jpg', 'jpeg', 'png', 'gif', 'bmp'] then
                                    DocAttachment."File Type" := DocAttachment."File Type"::Image
                                else if LowerCase(DocAttachment."File Extension") = 'pdf' then
                                    DocAttachment."File Type" := DocAttachment."File Type"::PDF
                                else if LowerCase(DocAttachment."File Extension") in ['doc', 'docx'] then
                                    DocAttachment."File Type" := DocAttachment."File Type"::Word
                                else if LowerCase(DocAttachment."File Extension") in ['xls', 'xlsx'] then
                                    DocAttachment."File Type" := DocAttachment."File Type"::Excel
                                else
                                    DocAttachment."File Type" := DocAttachment."File Type"::Other;
                                    
                                DocAttachment."Document Reference ID".ImportStream(AttInStr, AttName);
                                DocAttachment.Insert(true);
                            end;
                        end;
                    end;
                end;
            end;
        end;
        
        // Update buffer table to reflect the created quote
        if RfqBuffer.Get(RfqNo) then begin
            RfqBuffer."Sales Quote Created" := CreatedQuoteNo;
            RfqBuffer.Modify();
        end;

        SalesLine.Reset();
        SalesLine.SetRange("Document Type", SalesLine."Document Type"::Quote);
        SalesLine.SetRange("Document No.", CreatedQuoteNo);
        if SalesLine.FindFirst() then
            UpdateAllItemRefContactsForQuote(SalesLine);
        
        Message('Sales Quote %1 created successfully!\\Summary:\- Total items: %2\- New Items Created: %3\- Existing Items Linked: %4',
            CreatedQuoteNo, ItemsArray.Count(), ItemsCreated, ItemsLinked);
    end;

    local procedure GetFileNameWithoutExtension(FullFileName: Text): Text
    var
        i: Integer;
        DotPos: Integer;
    begin
        DotPos := 0;
        for i := StrLen(FullFileName) downto 1 do begin
            if (FullFileName[i] = '.') and (DotPos = 0) then
                DotPos := i;
        end;
        if DotPos > 1 then
            exit(CopyStr(FullFileName, 1, DotPos - 1));
        exit(FullFileName);
    end;

    local procedure GetFileExtension(FullFileName: Text): Text
    var
        i: Integer;
        DotPos: Integer;
    begin
        DotPos := 0;
        for i := StrLen(FullFileName) downto 1 do begin
            if (FullFileName[i] = '.') and (DotPos = 0) then
                DotPos := i;
        end;
        if (DotPos > 0) and (DotPos < StrLen(FullFileName)) then
            exit(CopyStr(FullFileName, DotPos + 1, StrLen(FullFileName) - DotPos));
        exit('');
    end;

    local procedure GetNewItemNo(): Code[20]
    var
        Item: Record Item;
        NewNo: Code[20];
        RandomNo: Integer;
    begin
        repeat
            RandomNo := Random(900000) + 100000; // Random 6 digit number
            NewNo := 'APSS-ITEM-' + Format(RandomNo);
        until not Item.Get(NewNo);
        exit(NewNo);
    end;

    local procedure CleanUomCode(UomText: Text): Code[10]
    var
        CleanCode: Code[10];
    begin
        CleanCode := UpperCase(CopyStr(DelChr(UomText, '=', ' '), 1, 10));
        if CleanCode = '' then
            CleanCode := 'PCS';
        exit(CleanCode);
    end;

    local procedure EnsureUnitOfMeasure(UomCode: Code[10])
    var
        UnitOfMeasure: Record "Unit of Measure";
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
    begin
        if not UnitOfMeasure.Get(UomCode) then begin
            UnitOfMeasure.Init();
            UnitOfMeasure.Code := UomCode;
            UnitOfMeasure.Description := UomCode;
            UnitOfMeasure.Insert(true);
        end;
        
        UnitOfMeasure.Get(UomCode);
        RecRef.GetTable(UnitOfMeasure);
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            if (FldRef.Number >= 50000) and (FldRef.Class = FieldClass::Normal) then begin
                if (FldRef.Name = 'APSS Base UOM') and (FldRef.Type = FieldType::Boolean) then begin
                    FldRef.Value := true;
                end;
            end;
        end;
        RecRef.Modify(true);
    end;

    local procedure EnsureItemUnitOfMeasure(ItemNo: Code[20]; UomCode: Code[10])
    var
        ItemUom: Record "Item Unit of Measure";
    begin
        ItemUom.Reset();
        ItemUom.SetRange("Item No.", ItemNo);
        ItemUom.SetRange(Code, UomCode);
        if ItemUom.IsEmpty() then begin
            ItemUom.Init();
            ItemUom."Item No." := ItemNo;
            ItemUom.Code := UomCode;
            ItemUom."Qty. per Unit of Measure" := 1.0;
            ItemUom.Insert(true);
        end;
    end;

    local procedure AssignDefaultPostingGroups(var Item: Record Item; CustomerNo: Code[20])
    var
        Customer: Record Customer;
        GenProdPostingGroup: Record "Gen. Product Posting Group";
        InventoryPostingGroup: Record "Inventory Posting Group";
        TargetProdPostingGroup: Code[20];
    begin
        TargetProdPostingGroup := 'GOODS_ZERO';
        if Customer.Get(CustomerNo) then begin
            if Customer."Gen. Bus. Posting Group" = 'LOCAL' then
                TargetProdPostingGroup := 'GOODS_GST'
            else if Customer."Gen. Bus. Posting Group" = 'OVERSEAS' then
                TargetProdPostingGroup := 'GOODS_ZERO';
        end;

        // 1. Assign Gen. Prod. Posting Group
        GenProdPostingGroup.Reset();
        if GenProdPostingGroup.Get(TargetProdPostingGroup) then
            Item.Validate("Gen. Prod. Posting Group", TargetProdPostingGroup)
        else if GenProdPostingGroup.Get('GOODS_OUTOFSCOPE') then
            Item.Validate("Gen. Prod. Posting Group", 'GOODS_OUTOFSCOPE')
        else if GenProdPostingGroup.Get('GOODS_GST9') then
            Item.Validate("Gen. Prod. Posting Group", 'GOODS_GST9')
        else if GenProdPostingGroup.FindFirst() then
            Item.Validate("Gen. Prod. Posting Group", GenProdPostingGroup.Code);

        // 2. Assign Inventory Posting Group
        InventoryPostingGroup.Reset();
        if InventoryPostingGroup.Get('RESALE') then
            Item.Validate("Inventory Posting Group", 'RESALE')
        else if InventoryPostingGroup.Get('FINISHED') then
            Item.Validate("Inventory Posting Group", 'FINISHED')
        else if InventoryPostingGroup.FindFirst() then
            Item.Validate("Inventory Posting Group", InventoryPostingGroup.Code);
    end;

    local procedure AssignDefaultCustomFields(var Item: Record Item; BrandText: Text; FullDesc: Text)
    var
        ItemRecRef: RecordRef;
        ExistingItemRecRef: RecordRef;
        FldRef: FieldRef;
        ExistingFldRef: FieldRef;
        i: Integer;
        FldNo: Integer;
        ExistingItem: Record Item;
        ItemCategory: Record "Item Category";
        FieldNameLower: Text;
    begin
        ItemRecRef.GetTable(Item);
        
        for i := 1 to ItemRecRef.FieldCount() do begin
            FldRef := ItemRecRef.FieldIndex(i);
            FldNo := FldRef.Number;
            FieldNameLower := LowerCase(FldRef.Name);
            
            // Handle custom fields (>= 50000) and Item Category Code (5702)
            if ((FldNo >= 50000) or (FieldNameLower = 'item category code') or (FieldNameLower = 'description 2')) and (FldRef.Class = FieldClass::Normal) then begin
                if (FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text) then begin
                    // If it is APSS Brand and we have a parsed brand, assign it first!
                    if FieldNameLower.Contains('brand') and (BrandText <> '') then begin
                        FldRef.Value := CopyStr(BrandText, 1, FldRef.Length);
                    end;

                    if FieldNameLower.Contains('long') or FieldNameLower.Contains('purch') or FieldNameLower.Contains('description') or FieldNameLower.Contains('specs') or FieldNameLower.Contains('detailed') then begin
                        if FullDesc <> '' then
                            FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
                    end;

                    // Check if it's currently blank/empty
                    if Format(FldRef.Value) = '' then begin
                        // Try to find a value from existing items
                        ExistingItem.Reset();
                        if ExistingItem.FindSet() then begin
                            repeat
                                ExistingItemRecRef.GetTable(ExistingItem);
                                ExistingFldRef := ExistingItemRecRef.Field(FldNo);
                                if Format(ExistingFldRef.Value) <> '' then begin
                                    FldRef.Validate(ExistingFldRef.Value);
                                    break;
                                end;
                            until ExistingItem.Next() = 0;
                        end;
                        
                        // Specific fallbacks if no existing items have values
                        if Format(FldRef.Value) = '' then begin
                            if FieldNameLower = 'apss brand' then
                                FldRef.Value := 'APSS';
                            if FieldNameLower = 'item category code' then begin
                                ItemCategory.Reset();
                                if ItemCategory.FindFirst() then
                                    FldRef.Validate(ItemCategory.Code);
                            end;
                        end;
                    end;
                end else if FldRef.Type = FieldType::Boolean then begin
                    if FieldNameLower.Contains('approved') or FieldNameLower.Contains('approve') then begin
                        FldRef.Value := false;
                    end;
                end;
            end;
        end;
        ItemRecRef.SetTable(Item);
    end;

    local procedure PopulateSalesLineCustomFields(var SalesLine: Record "Sales Line"; BrandText: Text; PartNoText: Text; FullDesc: Text; LeadTimeWeeks: Integer; CustLineNo: Integer)
    var
        SalesLineRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
    begin
        SalesLineRecRef.GetTable(SalesLine);
        
        for i := 1 to SalesLineRecRef.FieldCount() do begin
            FldRef := SalesLineRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            
            if (FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text) then begin
                if FieldNameClean.Contains('brand') and (BrandText <> '') then begin
                    FldRef.Value := CopyStr(BrandText, 1, FldRef.Length);
                end;
                
                if FieldNameClean.Contains('ref') and (PartNoText <> '') then begin
                    FldRef.Value := CopyStr(PartNoText, 1, FldRef.Length);
                end;

                if IsSalesLineDescriptionTarget(FieldNameClean) then begin
                    if FullDesc <> '' then
                        FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
                end;
            end;
            
            if (FldRef.Type = FieldType::Integer) or (FldRef.Type = FieldType::Decimal) then begin
                if FieldNameClean.Contains('leadtime') or FieldNameClean.Contains('salesleadtime') then begin
                    FldRef.Value := LeadTimeWeeks;
                end;
                if FieldNameClean.Contains('cust') and FieldNameClean.Contains('line') and (CustLineNo <> 0) then begin
                    FldRef.Value := CustLineNo;
                end;
            end;
        end;

        if (FullDesc <> '') and HasFieldNo(SalesLineRecRef, 50011) then begin
            FldRef := SalesLineRecRef.Field(50011);
            if (FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text) then
                FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
        end;
        
        SalesLineRecRef.SetTable(SalesLine);
    end;

    local procedure GetJsonValueAsText(var JObject: JsonObject; KeyName: Text): Text
    var
        ValueToken: JsonToken;
        Value: JsonValue;
    begin
        if not JObject.Get(KeyName, ValueToken) then
            exit('');
            
        if ValueToken.IsValue() then begin
            Value := ValueToken.AsValue();
            if not Value.IsNull() then
                exit(Value.AsText());
        end;
        exit('');
    end;

    local procedure GetJsonValueAsInteger(var JObject: JsonObject; KeyName: Text): Integer
    var
        ValueToken: JsonToken;
        Value: JsonValue;
    begin
        if not JObject.Get(KeyName, ValueToken) then
            exit(0);
            
        if ValueToken.IsValue() then begin
            Value := ValueToken.AsValue();
            if not Value.IsNull() then
                exit(Value.AsInteger());
        end;
        exit(0);
    end;

    local procedure ValidateAndGetAssignedValue(ValueToAssign: Code[50]): Code[50]
    var
        User: Record User;
        Salesperson: Record "Salesperson/Purchaser";
    begin
        // 1. Try exact match first in User table
        User.Reset();
        User.SetRange("User Name", ValueToAssign);
        if User.FindFirst() then
            exit(User."User Name");
            
        // 2. Try exact match in Salesperson/Purchaser table
        Salesperson.Reset();
        Salesperson.SetRange(Code, ValueToAssign);
        if Salesperson.FindFirst() then
            exit(Salesperson.Code);
            
        // 3. Try partial/case-insensitive matches (e.g. LOGIST*)
        User.Reset();
        User.SetFilter("User Name", '@' + ValueToAssign + '*');
        if User.FindFirst() then
            exit(User."User Name");
            
        Salesperson.Reset();
        Salesperson.SetFilter(Code, '@' + ValueToAssign + '*');
        if Salesperson.FindFirst() then
            exit(Salesperson.Code);

        // 4. Fallback search for LOGISTIC specifically looking for LOGIST*
        if ValueToAssign = 'LOGISTIC' then begin
            User.Reset();
            User.SetFilter("User Name", '@LOGIST*');
            if User.FindFirst() then
                exit(User."User Name");
                
            Salesperson.Reset();
            Salesperson.SetFilter(Code, '@LOGIST*');
            if Salesperson.FindFirst() then
                exit(Salesperson.Code);
        end;

        exit('');
    end;

    local procedure ParseDateText(DateText: Text): Date
    var
        DayText: Text;
        MonthText: Text;
        YearText: Text;
        DayInt: Integer;
        MonthInt: Integer;
        YearInt: Integer;
        Parts: List of [Text];
    begin
        if DateText = '' then
            exit(0D);
            
        if DateText.Contains('-') then
            Parts := DateText.Split('-')
        else if DateText.Contains('/') then
            Parts := DateText.Split('/')
        else
            exit(0D);
            
        if Parts.Count() <> 3 then
            exit(0D);
            
        if StrLen(Parts.Get(1)) = 4 then begin
            YearText := Parts.Get(1);
            MonthText := Parts.Get(2);
            DayText := Parts.Get(3);
        end else begin
            DayText := Parts.Get(1);
            MonthText := Parts.Get(2);
            YearText := Parts.Get(3);
        end;
        
        if not Evaluate(DayInt, DayText) then
            exit(0D);
        if not Evaluate(MonthInt, MonthText) then
            exit(0D);
        if not Evaluate(YearInt, YearText) then
            exit(0D);
            
        exit(DMY2Date(DayInt, MonthInt, YearInt));
    end;

    local procedure AssignSalesHeaderCustomFields(var SalesHeader: Record "Sales Header")
    var
        SalesHeaderRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameLower: Text;
        FieldCaptionLower: Text;
        HasChanged: Boolean;
        ValueToAssign: Code[50];
    begin
        SalesHeaderRecRef.GetTable(SalesHeader);
        HasChanged := false;
        
        for i := 1 to SalesHeaderRecRef.FieldCount() do begin
            FldRef := SalesHeaderRecRef.FieldIndex(i);
            if (FldRef.Number >= 50000) and (FldRef.Class = FieldClass::Normal) then begin
                FieldNameLower := LowerCase(FldRef.Name);
                FieldCaptionLower := LowerCase(FldRef.Caption);
                
                if (FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text) then begin
                    if FieldNameLower.Contains('logistic') or FieldCaptionLower.Contains('logistic') then begin
                        ValueToAssign := ValidateAndGetAssignedValue('LOGISTIC');
                        if ValueToAssign <> '' then begin
                            FldRef.Value := ValueToAssign;
                            HasChanged := true;
                        end;
                    end;
                    
                    if FieldNameLower.Contains('account') or FieldCaptionLower.Contains('account') then begin
                        ValueToAssign := ValidateAndGetAssignedValue('ACCOUNT');
                        if ValueToAssign <> '' then begin
                            FldRef.Value := ValueToAssign;
                            HasChanged := true;
                        end;
                    end;
                    
                    if FieldNameLower.Contains('admin') or FieldCaptionLower.Contains('admin') then begin
                        ValueToAssign := ValidateAndGetAssignedValue('ADMIN');
                        if ValueToAssign <> '' then begin
                            FldRef.Value := ValueToAssign;
                            HasChanged := true;
                        end;
                    end;
                end;
            end;
        end;
        
        if HasChanged then begin
            SalesHeaderRecRef.Modify(true);
            SalesHeader.Get(SalesHeader."Document Type", SalesHeader."No.");
        end;
    end;

    [TryFunction]
    local procedure TryOpenRecordRef(var RecRef: RecordRef; TableNo: Integer)
    begin
        RecRef.Open(TableNo);
    end;

    local procedure GetSalesLineFieldText(var SalesLine: Record "Sales Line"; Pattern: Text): Text
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameLower: Text;
    begin
        RecRef.GetTable(SalesLine);
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameLower := LowerCase(FldRef.Name);
            if FieldNameLower.Contains(Pattern) then begin
                exit(Format(FldRef.Value));
            end;
        end;
        exit('');
    end;

    local procedure GetSalesHeaderFieldText(DocumentNo: Code[20]; Pattern: Text): Text
    var
        SalesHeader: Record "Sales Header";
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameLower: Text;
    begin
        if not SalesHeader.Get(SalesHeader."Document Type"::Quote, DocumentNo) then
            exit('');
            
        RecRef.GetTable(SalesHeader);
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameLower := LowerCase(FldRef.Name);
            if FieldNameLower.Contains(Pattern) then begin
                exit(Format(FldRef.Value));
            end;
        end;
        exit('');
    end;

    local procedure UpdateItemRefFields(var RecRef: RecordRef; var SalesLine: Record "Sales Line"; var SalesHeader: Record "Sales Header"; PartNo: Text; BrandText: Text; FullDesc: Text; CustLineNo: Integer; LeadTimeWeeks: Integer)
    var
        i: Integer;
        FldRef: FieldRef;
        FieldNameClean: Text;
        IncoLoc: Text;
        ShipMethod: Text;
    begin
        IncoLoc := GetSalesLineFieldText(SalesLine, 'incoterm');
        ShipMethod := GetSalesLineFieldText(SalesLine, 'shipment method');
        if ShipMethod = '' then
            ShipMethod := GetSalesHeaderFieldText(SalesLine."Document No.", 'shipment method');

        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            
            // Assign Item No
            if ((FieldNameClean = 'no') or (FieldNameClean = 'itemno') or (FieldNameClean = 'apssitemno')) and (SalesLine."No." <> '') then begin
                FldRef.Value := SalesLine."No.";
            end;
            
            // Assign Description
            if (FieldNameClean = 'description') and (SalesLine.Description <> '') then begin
                FldRef.Value := CopyStr(SalesLine.Description, 1, FldRef.Length);
            end;
            
            // Assign Item Reference No. / Part Number / Reference No.
            if (FieldNameClean.Contains('referenceno') or FieldNameClean.Contains('refno') or (FieldNameClean = 'partno') or (FieldNameClean = 'partnumber') or (FieldNameClean = 'vendoritemno')) then begin
                if PartNo <> '' then
                    FldRef.Value := CopyStr(PartNo, 1, FldRef.Length)
                else if SalesLine."No." <> '' then
                    FldRef.Value := CopyStr(SalesLine."No.", 1, FldRef.Length)
                else
                    FldRef.Value := 'N/A';
            end;
            
            // Assign Long Description
            if (FieldNameClean.Contains('longdescription') or FieldNameClean.Contains('longdesc') or FieldNameClean.Contains('purchlongdesc') or FieldNameClean.Contains('specs')) and (FullDesc <> '') then begin
                FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
            end;
            
            // Assign Purchase Description
            if (FieldNameClean.Contains('purchasedescription') or FieldNameClean.Contains('purchasedesc') or FieldNameClean.Contains('purchdesc') or FieldNameClean.Contains('purchlongdesc') or (FieldNameClean = 'purchdescription')) and (FullDesc <> '') then begin
                FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
            end;
            
            // Assign Brand Code
            if FieldNameClean.Contains('brand') and (BrandText <> '') then begin
                FldRef.Value := CopyStr(BrandText, 1, FldRef.Length);
            end;
            
            // Assign Salesperson Code
            if FieldNameClean.Contains('salesperson') and (SalesHeader."Salesperson Code" <> '') then begin
                FldRef.Value := CopyStr(SalesHeader."Salesperson Code", 1, FldRef.Length);
            end;
            
            // Assign Business Unit Code
            if (FieldNameClean.Contains('businessunit') or FieldNameClean.Contains('bucode') or FieldNameClean.Contains('shortcutdimension1')) and (SalesHeader."Shortcut Dimension 1 Code" <> '') then begin
                FldRef.Value := CopyStr(SalesHeader."Shortcut Dimension 1 Code", 1, FldRef.Length);
            end;
            
            // Assign Customer Code / Customer No.
            if (FieldNameClean.Contains('customercode') or FieldNameClean.Contains('customerno') or FieldNameClean.Contains('selltocustomer')) and (SalesHeader."Sell-to Customer No." <> '') then begin
                FldRef.Value := CopyStr(SalesHeader."Sell-to Customer No.", 1, FldRef.Length);
            end;

            // Assign Customer Name
            if FieldNameClean.Contains('customername') and (SalesHeader."Sell-to Customer Name" <> '') then begin
                FldRef.Value := CopyStr(SalesHeader."Sell-to Customer Name", 1, FldRef.Length);
            end;
            
            // Assign Location Code
            if (FieldNameClean = 'locationcode') and (SalesLine."Location Code" <> '') then begin
                FldRef.Value := CopyStr(SalesLine."Location Code", 1, FldRef.Length);
            end;
            
            // Assign Customer Line No
            if (FieldNameClean.Contains('custlineno') or FieldNameClean.Contains('customerlineno') or (FieldNameClean = 'custline')) and (CustLineNo <> 0) then begin
                FldRef.Value := CustLineNo;
            end;
            
            // Assign Lead Time
            if FieldNameClean.Contains('leadtime') or FieldNameClean.Contains('salesleadtime') then begin
                FldRef.Value := LeadTimeWeeks;
            end;
            
            // Assign Shipment Method Code
            if FieldNameClean.Contains('shipmentmethod') then begin
                if ShipMethod <> '' then
                    FldRef.Value := CopyStr(ShipMethod, 1, FldRef.Length)
                else
                    FldRef.Value := 'DDP';
            end;
            
            // Assign Incoterm Location
            if FieldNameClean.Contains('incotermlocation') or FieldNameClean.Contains('incoterm') then begin
                if IncoLoc <> '' then
                    FldRef.Value := CopyStr(IncoLoc, 1, FldRef.Length)
                else
                    FldRef.Value := 'Singapore';
            end;

            // Assign Unit of Measure Code
            if FieldNameClean.Contains('unitofmeasure') or (FieldNameClean = 'uomcode') or (FieldNameClean = 'uom') then begin
                if SalesLine."Unit of Measure Code" <> '' then
                    FldRef.Value := SalesLine."Unit of Measure Code"
                else
                    FldRef.Value := 'PCS';
            end;

            // Assign Quantity
            if (FieldNameClean = 'quantity') or (FieldNameClean = 'qty') then begin
                FldRef.Value := SalesLine.Quantity;
            end;
            if (FieldNameClean = 'quantitybase') or (FieldNameClean = 'qtybase') then begin
                FldRef.Value := SalesLine."Quantity (Base)";
            end;
        end;
    end;

    local procedure PopulateItemRefContact(var SalesLine: Record "Sales Line"; PartNo: Text; BrandText: Text; FullDesc: Text; CustLineNo: Integer; LeadTimeWeeks: Integer)
    var
        ItemRefRecRef: RecordRef;
        FldRef: FieldRef;
        FieldNameClean: Text;
        i: Integer;
        SalesHeader: Record "Sales Header";
    begin
        ItemRefRecRef.Open(50013);
        
        if not SalesHeader.Get(SalesLine."Document Type", SalesLine."Document No.") then
            Clear(SalesHeader);
            
        // Look up fields for Sales Order No./Document No. and Line No. to set filter
        for i := 1 to ItemRefRecRef.FieldCount() do begin
            FldRef := ItemRefRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(SalesLine."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(SalesLine."Line No.");
        end;
        
        if ItemRefRecRef.FindFirst() then begin
            UpdateItemRefFields(ItemRefRecRef, SalesLine, SalesHeader, PartNo, BrandText, FullDesc, CustLineNo, LeadTimeWeeks);
            ItemRefRecRef.Modify(true);
        end else begin
            ItemRefRecRef.Init();
            
            for i := 1 to ItemRefRecRef.FieldCount() do begin
                FldRef := ItemRefRecRef.FieldIndex(i);
                FieldNameClean := CleanFieldName(FldRef.Name);
                if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                    FldRef.Value := SalesLine."Document No.";
                if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                    FldRef.Value := SalesLine."Line No.";
            end;
            
            UpdateItemRefFields(ItemRefRecRef, SalesLine, SalesHeader, PartNo, BrandText, FullDesc, CustLineNo, LeadTimeWeeks);
            ItemRefRecRef.Insert(true);
        end;
    end;

    local procedure FindExistingItem(PartNoText: Text; MatDesc: Text[100]; var Item: Record Item): Boolean
    var
        ItemReference: Record "Item Reference";
        CleanPartNo: Code[50];
    begin
        // 1. Try exact match on Description
        Item.Reset();
        Item.SetRange(Description, MatDesc);
        if Item.FindFirst() then
            exit(true);

        // 2. Try match on Item No. using PartNoText
        if PartNoText <> '' then begin
            CleanPartNo := CopyStr(DelChr(PartNoText, '=', ' -/.\'), 1, 20); // remove spaces/dashes/slashes
            
            Item.Reset();
            if StrLen(PartNoText) <= 20 then begin
                if Item.Get(PartNoText) then
                    exit(true);
            end;
                
            // Check Vendor Item No. (Field 19)
            Item.Reset();
            Item.SetRange("Vendor Item No.", PartNoText);
            if Item.FindFirst() then
                exit(true);

            // Check Item Reference (Table 5777)
            ItemReference.Reset();
            ItemReference.SetRange("Reference No.", PartNoText);
            if ItemReference.FindFirst() then begin
                if Item.Get(ItemReference."Item No.") then
                    exit(true);
            end;
            
            // Try matching clean part number (alphanumeric search)
            if CleanPartNo <> '' then begin
                // Remove parentheses or any filter characters from CleanPartNo to prevent syntax error in SetFilter
                CleanPartNo := CopyStr(DelChr(CleanPartNo, '=', '()&|><*?@'), 1, 50);
                if CleanPartNo <> '' then begin
                    // Check Vendor Item No. with partial matching
                    Item.Reset();
                    Item.SetFilter("Vendor Item No.", '@*' + CleanPartNo + '*');
                    if Item.FindFirst() then
                        exit(true);

                    // Check Item No. with partial matching
                    Item.Reset();
                    Item.SetFilter("No.", '@*' + CleanPartNo + '*');
                    if Item.FindFirst() then
                        exit(true);
                end;
            end;
        end;

        // 3. Try fuzzy/partial match on Description containing the part number
        if PartNoText <> '' then begin
            PartNoText := DelChr(PartNoText, '=', '()&|><*?@');
            if PartNoText <> '' then begin
                Item.Reset();
                Item.SetFilter(Description, '@*' + PartNoText + '*');
                if Item.FindFirst() then
                    exit(true);
            end;
        end;

        exit(false);
    end;

    local procedure EnsureItemReference(ItemNo: Code[20]; PartNo: Text; BrandText: Text; UomCode: Code[10]; CustomerNo: Code[20])
    var
        ItemReference: Record "Item Reference";
    begin
        if (PartNo = '') or (CustomerNo = '') then
            exit;

        EnsureUnitOfMeasure(UomCode);
        EnsureItemUnitOfMeasure(ItemNo, UomCode);
            
        // 1. Create Customer-specific reference
        ItemReference.Reset();
        ItemReference.SetRange("Item No.", ItemNo);
        ItemReference.SetRange("Reference Type", ItemReference."Reference Type"::Customer);
        ItemReference.SetRange("Reference Type No.", CustomerNo);
        ItemReference.SetRange("Reference No.", CopyStr(PartNo, 1, 50));
        if ItemReference.IsEmpty() then begin
            ItemReference.Init();
            ItemReference.Validate("Item No.", ItemNo);
            ItemReference.Validate("Reference Type", ItemReference."Reference Type"::Customer);
            ItemReference.Validate("Reference Type No.", CustomerNo);
            ItemReference.Validate("Unit of Measure", UomCode);
            ItemReference.Validate("Reference No.", CopyStr(PartNo, 1, 50));
            ItemReference.Validate(Description, CopyStr(PartNo, 1, 100));
            ItemReference.Insert(true);
        end;

        // 2. Also create a Common reference (Reference Type = " ") for fallback/general search
        ItemReference.Reset();
        ItemReference.SetRange("Item No.", ItemNo);
        ItemReference.SetRange("Reference Type", ItemReference."Reference Type"::" ");
        ItemReference.SetRange("Reference No.", CopyStr(PartNo, 1, 50));
        if ItemReference.IsEmpty() then begin
            ItemReference.Init();
            ItemReference.Validate("Item No.", ItemNo);
            ItemReference.Validate("Reference Type", ItemReference."Reference Type"::" ");
            ItemReference.Validate("Unit of Measure", UomCode);
            ItemReference.Validate("Reference No.", CopyStr(PartNo, 1, 50));
            ItemReference.Validate(Description, CopyStr(PartNo, 1, 100));
            ItemReference.Insert(true);
        end;
    end;

    local procedure DebugTableFields(TableNo: Integer)
    var
        RecRef: RecordRef;
        i: Integer;
        FldRef: FieldRef;
        Msg: Text;
    begin
        if not TryOpenRecordRef(RecRef, TableNo) then begin
            Message('Table %1 cannot be opened.', TableNo);
            exit;
        end;
        Msg := 'Table ' + Format(TableNo) + ' Fields:\';
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            Msg += FldRef.Name + ' (' + Format(FldRef.Type) + ')\';
            if StrLen(Msg) > 800 then begin
                Message(Msg);
                Msg := 'Table ' + Format(TableNo) + ' Fields continued:\';
            end;
        end;
        if Msg <> '' then
            Message(Msg);
    end;

    local procedure ErrorTableRecords(TableNo: Integer)
    var
        RecRef: RecordRef;
        i: Integer;
        FldRef: FieldRef;
        Msg: Text;
        Count: Integer;
    begin
        RecRef.Open(TableNo);
            
        Msg := 'Table ' + Format(TableNo) + ' Records: \';
        if RecRef.FindSet() then begin
            repeat
                Count += 1;
                Msg += '#' + Format(Count) + ': ';
                for i := 1 to RecRef.FieldCount() do begin
                    FldRef := RecRef.FieldIndex(i);
                    if Format(FldRef.Value) <> '' then begin
                        Msg += FldRef.Name + '=' + Format(FldRef.Value) + '; ';
                    end;
                end;
                Msg += '\';
                if StrLen(Msg) > 800 then begin
                    Error(Msg);
                end;
            until (RecRef.Next() = 0) or (Count >= 15);
        end;
        if Msg <> '' then
            Error(Msg)
        else
            Error('Table ' + Format(TableNo) + ' has no records.');
    end;

    [EventSubscriber(ObjectType::Table, Database::"Sales Line", 'OnAfterValidateEvent', 'No.', false, false)]
    local procedure OnAfterValidateSalesLineNo(var Rec: Record "Sales Line"; var xRec: Record "Sales Line")
    var
        ItemRefRecRef: RecordRef;
        FldRef: FieldRef;
        FieldNameClean: Text;
        i: Integer;
        SalesHeader: Record "Sales Header";
        TempSalesLine: Record "Sales Line";
        SourcingItemNo: Code[20];
        PartNo: Text;
        Found: Boolean;
    begin
        if Rec.IsTemporary() then
            exit;
        if Rec.Type <> Rec.Type::Item then
            exit;
        if Rec."No." = '' then
            exit;

        // Try to get the original record from the database to restore fields on same-item revalidation (xRec can be empty/blank on Lookups)
        if TempSalesLine.Get(Rec."Document Type", Rec."Document No.", Rec."Line No.") then begin
            if (TempSalesLine."No." = Rec."No.") and (TempSalesLine."No." <> '') then begin
                Rec."Item Reference No." := TempSalesLine."Item Reference No.";
                RestoreCustomFieldsFromSalesLine(Rec, TempSalesLine);
                
                // Also restore the Sourcing Table 50013 record!
                RestoreSourcingRecordFromSalesLine(Rec);
                
                Rec.Modify(false);
                exit;
            end;
        end;

        if not SalesHeader.Get(Rec."Document Type", Rec."Document No.") then
            exit;

        Found := false;
        ItemRefRecRef.Open(50013);
        
        // Filter by Document No. and Line No.
        for i := 1 to ItemRefRecRef.FieldCount() do begin
            FldRef := ItemRefRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(Rec."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(Rec."Line No.");
        end;

        if ItemRefRecRef.FindFirst() then begin
            Found := true;
            // Get the Item No currently stored in Table 50013
            SourcingItemNo := '';
            for i := 1 to ItemRefRecRef.FieldCount() do begin
                FldRef := ItemRefRecRef.FieldIndex(i);
                FieldNameClean := CleanFieldName(FldRef.Name);
                if (FieldNameClean = 'no') or (FieldNameClean = 'itemno') then
                    SourcingItemNo := CopyStr(Format(FldRef.Value), 1, 20);
            end;

            if (SourcingItemNo = Rec."No.") or (SourcingItemNo = '') then begin
                // Restore fields from Table 50013
                // 1. Restore Item Reference No.
                for i := 1 to ItemRefRecRef.FieldCount() do begin
                    FldRef := ItemRefRecRef.FieldIndex(i);
                    FieldNameClean := CleanFieldName(FldRef.Name);
                    if (FieldNameClean.Contains('referenceno') or FieldNameClean.Contains('refno') or (FieldNameClean = 'partno') or (FieldNameClean = 'partnumber') or (FieldNameClean = 'vendoritemno')) then begin
                        if Format(FldRef.Value) <> '' then begin
                            Rec."Item Reference No." := CopyStr(Format(FldRef.Value), 1, MaxStrLen(Rec."Item Reference No."));
                        end;
                    end;
                end;

                // 2. Restore custom description and other custom fields on Sales Line
                RestoreSalesLineCustomFields(Rec, ItemRefRecRef);
            end else begin
                // The item has been changed! Copy custom fields from the new Item Card
                CopyCustomFieldsFromItem(Rec, Rec."No.");
                PartNo := FindItemReference(Rec."No.", SalesHeader."Sell-to Customer No.");
                if PartNo <> '' then
                    Rec."Item Reference No." := CopyStr(PartNo, 1, MaxStrLen(Rec."Item Reference No."));
                
                // Also update the sourcing record to match the new item details
                UpdateSourcingRecordFromSalesLine(ItemRefRecRef, Rec, SalesHeader);
            end;
        end else begin
            // No Table 50013 record exists for this line. Populate from Item Card & Item References.
            CopyCustomFieldsFromItem(Rec, Rec."No.");
            PartNo := FindItemReference(Rec."No.", SalesHeader."Sell-to Customer No.");
            if PartNo <> '' then
                Rec."Item Reference No." := CopyStr(PartNo, 1, MaxStrLen(Rec."Item Reference No."));
        end;
        
        ItemRefRecRef.Close();

        // Save changes to database if the Sales Line record exists (this prevents issues with warning dialogs / reload)
        if TempSalesLine.Get(Rec."Document Type", Rec."Document No.", Rec."Line No.") then begin
            Rec.Modify(false);
        end;
    end;

    local procedure RestoreSourcingRecordFromSalesLine(var SalesLine: Record "Sales Line")
    var
        ItemRefRecRef: RecordRef;
        FldRef: FieldRef;
        FieldNameClean: Text;
        i: Integer;
        SalesHeader: Record "Sales Header";
        PartNo: Text;
        BrandText: Text;
        FullDesc: Text;
        LeadTimeWeeks: Integer;
        CustLineNo: Integer;
    begin
        if not SalesHeader.Get(SalesLine."Document Type", SalesLine."Document No.") then
            Clear(SalesHeader);

        ItemRefRecRef.Open(50013);
        
        // Filter by Document No. and Line No.
        for i := 1 to ItemRefRecRef.FieldCount() do begin
            FldRef := ItemRefRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(SalesLine."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(SalesLine."Line No.");
        end;

        if ItemRefRecRef.FindFirst() then begin
            // Get values from Sales Line to restore in Table 50013
            PartNo := SalesLine."Item Reference No.";
            BrandText := GetSalesLineFieldText(SalesLine, 'brand');
            FullDesc := GetSalesLineFieldText(SalesLine, 'long');
            if FullDesc = '' then
                FullDesc := GetSalesLineFieldText(SalesLine, 'description 2');
            LeadTimeWeeks := GetSalesLineIntegerVal(SalesLine, 'lead time');
            CustLineNo := GetSalesLineIntegerVal(SalesLine, 'cust');

            UpdateItemRefFields(ItemRefRecRef, SalesLine, SalesHeader, PartNo, BrandText, FullDesc, CustLineNo, LeadTimeWeeks);
            ItemRefRecRef.Modify(true);
        end;
        ItemRefRecRef.Close();
    end;

    local procedure RestoreCustomFieldsFromSalesLine(var Target: Record "Sales Line"; var Source: Record "Sales Line")
    var
        TargetRecRef: RecordRef;
        SourceRecRef: RecordRef;
        TargetFldRef: FieldRef;
        SourceFldRef: FieldRef;
        i: Integer;
    begin
        TargetRecRef.GetTable(Target);
        SourceRecRef.GetTable(Source);
        for i := 1 to TargetRecRef.FieldCount() do begin
            TargetFldRef := TargetRecRef.FieldIndex(i);
            if (TargetFldRef.Number >= 50000) and (TargetFldRef.Class = FieldClass::Normal) then begin
                SourceFldRef := SourceRecRef.Field(TargetFldRef.Number);
                TargetFldRef.Value := SourceFldRef.Value;
            end;
        end;
        TargetRecRef.SetTable(Target);
    end;

    local procedure FindItemReference(ItemNo: Code[20]; CustomerNo: Code[20]): Code[50]
    var
        ItemReference: Record "Item Reference";
    begin
        if ItemNo = '' then
            exit('');
        ItemReference.Reset();
        ItemReference.SetRange("Item No.", ItemNo);
        if CustomerNo <> '' then begin
            ItemReference.SetRange("Reference Type", ItemReference."Reference Type"::Customer);
            ItemReference.SetRange("Reference Type No.", CustomerNo);
            if ItemReference.FindFirst() then
                exit(ItemReference."Reference No.");
        end;

        ItemReference.Reset();
        ItemReference.SetRange("Item No.", ItemNo);
        ItemReference.SetRange("Reference Type", ItemReference."Reference Type"::" ");
        if ItemReference.FindFirst() then
            exit(ItemReference."Reference No.");

        exit('');
    end;

    local procedure CopyCustomFieldsFromItem(var SalesLine: Record "Sales Line"; ItemNo: Code[20])
    var
        Item: Record Item;
        ItemRecRef: RecordRef;
        SalesLineRecRef: RecordRef;
        ItemFldRef: FieldRef;
        SalesLineFldRef: FieldRef;
        i: Integer;
        j: Integer;
        FieldNameLower: Text;
        SalesLineFieldNameLower: Text;
    begin
        if not Item.Get(ItemNo) then
            exit;
        ItemRecRef.GetTable(Item);
        SalesLineRecRef.GetTable(SalesLine);

        for i := 1 to ItemRecRef.FieldCount() do begin
            ItemFldRef := ItemRecRef.FieldIndex(i);
            FieldNameLower := LowerCase(ItemFldRef.Name);

            // Handle Brand
            if FieldNameLower.Contains('brand') and (Format(ItemFldRef.Value) <> '') then begin
                for j := 1 to SalesLineRecRef.FieldCount() do begin
                    SalesLineFldRef := SalesLineRecRef.FieldIndex(j);
                    SalesLineFieldNameLower := LowerCase(SalesLineFldRef.Name);
                    if SalesLineFieldNameLower.Contains('brand') then begin
                        SalesLineFldRef.Value := CopyStr(Format(ItemFldRef.Value), 1, SalesLineFldRef.Length);
                    end;
                end;
            end;

            // Handle Long Description (from Description 2)
            if (FieldNameLower = 'description 2') and (Format(ItemFldRef.Value) <> '') then begin
                for j := 1 to SalesLineRecRef.FieldCount() do begin
                    SalesLineFldRef := SalesLineRecRef.FieldIndex(j);
                    SalesLineFieldNameLower := LowerCase(SalesLineFldRef.Name);
                    if SalesLineFieldNameLower.Contains('long') or SalesLineFieldNameLower.Contains('apss description') or (SalesLineFieldNameLower = 'description 2') then begin
                        SalesLineFldRef.Value := CopyStr(Format(ItemFldRef.Value), 1, SalesLineFldRef.Length);
                    end;
                end;
            end;
        end;
        SalesLineRecRef.SetTable(SalesLine);
    end;

    local procedure GetItemCustomDetails(ItemNo: Code[20]; var BrandText: Text; var FullDesc: Text)
    var
        Item: Record Item;
        ItemRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameLower: Text;
    begin
        if not Item.Get(ItemNo) then
            exit;
        ItemRecRef.GetTable(Item);
        for i := 1 to ItemRecRef.FieldCount() do begin
            FldRef := ItemRecRef.FieldIndex(i);
            FieldNameLower := LowerCase(FldRef.Name);
            if FieldNameLower.Contains('brand') and (Format(FldRef.Value) <> '') then
                BrandText := Format(FldRef.Value);
            if (FieldNameLower = 'description 2') and (Format(FldRef.Value) <> '') then
                FullDesc := Format(FldRef.Value);
        end;
    end;

    local procedure GetSalesLineIntegerVal(var SalesLine: Record "Sales Line"; Pattern: Text): Integer
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameLower: Text;
        ValInt: Integer;
    begin
        RecRef.GetTable(SalesLine);
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameLower := LowerCase(FldRef.Name);
            if FieldNameLower.Contains(Pattern) then begin
                if (FldRef.Type = FieldType::Integer) or (FldRef.Type = FieldType::Decimal) then begin
                    if Evaluate(ValInt, Format(FldRef.Value)) then
                        exit(ValInt);
                end;
            end;
        end;
        exit(0);
    end;

    local procedure UpdateSourcingRecordFromSalesLine(var ItemRefRecRef: RecordRef; var SalesLine: Record "Sales Line"; var SalesHeader: Record "Sales Header")
    var
        PartNo: Text;
        BrandText: Text;
        FullDesc: Text;
        LeadTimeWeeks: Integer;
        CustLineNo: Integer;
    begin
        PartNo := FindItemReference(SalesLine."No.", SalesHeader."Sell-to Customer No.");
        GetItemCustomDetails(SalesLine."No.", BrandText, FullDesc);
        LeadTimeWeeks := GetSalesLineIntegerVal(SalesLine, 'lead time');
        CustLineNo := GetSalesLineIntegerVal(SalesLine, 'cust');

        UpdateItemRefFields(ItemRefRecRef, SalesLine, SalesHeader, PartNo, BrandText, FullDesc, CustLineNo, LeadTimeWeeks);
        ItemRefRecRef.Modify(true);
    end;

    local procedure RestoreSalesLineCustomFields(var SalesLine: Record "Sales Line"; var ItemRefRecRef: RecordRef)
    var
        SalesLineRecRef: RecordRef;
        SalesLineFldRef: FieldRef;
        ItemRefFldRef: FieldRef;
        i: Integer;
        j: Integer;
        SalesLineFieldNameClean: Text;
        ItemRefFieldNameClean: Text;
        Matched: Boolean;
    begin
        SalesLineRecRef.GetTable(SalesLine);
        
        for i := 1 to SalesLineRecRef.FieldCount() do begin
            SalesLineFldRef := SalesLineRecRef.FieldIndex(i);
            if (SalesLineFldRef.Number >= 50000) and (SalesLineFldRef.Class = FieldClass::Normal) then begin
                SalesLineFieldNameClean := CleanFieldName(SalesLineFldRef.Name);
                
                // Find matching field in Table 50013
                for j := 1 to ItemRefRecRef.FieldCount() do begin
                    ItemRefFldRef := ItemRefRecRef.FieldIndex(j);
                    ItemRefFieldNameClean := CleanFieldName(ItemRefFldRef.Name);
                    
                    Matched := false;

                    // 1. Brand Code Match
                    if SalesLineFieldNameClean.Contains('brand') and ItemRefFieldNameClean.Contains('brand') then
                        Matched := true;

                    // 2. Reference No Match
                    if not Matched then begin
                        if (SalesLineFieldNameClean.Contains('referenceno') or SalesLineFieldNameClean.Contains('refno') or (SalesLineFieldNameClean = 'partno') or (SalesLineFieldNameClean = 'partnumber')) and
                           (ItemRefFieldNameClean.Contains('referenceno') or ItemRefFieldNameClean.Contains('refno') or (ItemRefFieldNameClean = 'partno') or (ItemRefFieldNameClean = 'partnumber')) then
                            Matched := true;
                    end;

                    // 3. Description Matching
                    if not Matched then begin
                        if (SalesLineFieldNameClean.Contains('longdescription') or SalesLineFieldNameClean.Contains('longdesc') or SalesLineFieldNameClean.Contains('purchlongdesc') or SalesLineFieldNameClean.Contains('specs')) and
                           (ItemRefFieldNameClean.Contains('longdescription') or ItemRefFieldNameClean.Contains('longdesc') or ItemRefFieldNameClean.Contains('purchlongdesc') or ItemRefFieldNameClean.Contains('specs')) then
                            Matched := true
                        else if (SalesLineFieldNameClean.Contains('purchasedescription') or SalesLineFieldNameClean.Contains('purchasedesc') or SalesLineFieldNameClean.Contains('purchdesc')) and
                                (ItemRefFieldNameClean.Contains('purchasedescription') or ItemRefFieldNameClean.Contains('purchasedesc') or ItemRefFieldNameClean.Contains('purchdesc')) then
                            Matched := true
                        else if (SalesLineFieldNameClean.Contains('deviationdescription') or SalesLineFieldNameClean.Contains('deviationdesc') or SalesLineFieldNameClean.Contains('deviation')) and
                                (ItemRefFieldNameClean.Contains('deviationdescription') or ItemRefFieldNameClean.Contains('deviationdesc') or ItemRefFieldNameClean.Contains('deviation')) then
                            Matched := true
                        else if (SalesLineFieldNameClean = 'description') and (ItemRefFieldNameClean = 'description') then
                            Matched := true;
                    end;

                    // 4. Lead Time Match
                    if not Matched then begin
                        if (SalesLineFieldNameClean.Contains('leadtime') or SalesLineFieldNameClean.Contains('salesleadtime')) and 
                           (ItemRefFieldNameClean.Contains('leadtime') or ItemRefFieldNameClean.Contains('salesleadtime')) then
                            Matched := true;
                    end;
                    
                    // 5. Customer Line No Match
                    if not Matched then begin
                        if (SalesLineFieldNameClean.Contains('custlineno') or SalesLineFieldNameClean.Contains('customerlineno') or (SalesLineFieldNameClean = 'custline')) and 
                           (ItemRefFieldNameClean.Contains('custlineno') or ItemRefFieldNameClean.Contains('customerlineno') or (ItemRefFieldNameClean = 'custline')) then
                            Matched := true;
                    end;

                    if Matched then begin
                        if Format(ItemRefFldRef.Value) <> '' then begin
                            SalesLineFldRef.Value := CopyStr(Format(ItemRefFldRef.Value), 1, SalesLineFldRef.Length);
                        end;
                    end;
                end;
            end;
        end;
        
        SalesLineRecRef.SetTable(SalesLine);
    end;

    local procedure SetItemApprovedDirectly(var Item: Record Item; Approved: Boolean)
    var
        ItemRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
    begin
        ItemRecRef.GetTable(Item);
        for i := 1 to ItemRecRef.FieldCount() do begin
            FldRef := ItemRecRef.FieldIndex(i);
            if FldRef.Number = 50001 then begin // APSS Approved
                FldRef.Value := Approved;
            end;
        end;
        ItemRecRef.SetTable(Item);
        Item.Modify(false); // Update database without running triggers to bypass approval reset logic
    end;

    procedure ShowSalesLineDiagnostics(var SalesLine: Record "Sales Line")
    var
        Msg: Text;
    begin
        if SalesLine."Document No." = '' then
            Error('Select a sales quote line first.');

        Msg := 'APSS Sales Line diagnostics\' +
               'Document: ' + Format(SalesLine."Document Type") + ' ' + SalesLine."Document No." + '\' +
               'Line No.: ' + Format(SalesLine."Line No.") + '\' +
               'Item No.: ' + SalesLine."No." + '\\' +
               '--- Sales Line fields ---\' +
               GetRecordFieldDiagnostics(Database::"Sales Line", SalesLine.RecordId(), true) +
               '\\--- Table 50013 records for this document/line ---\' +
               GetTable50013Diagnostics(SalesLine);

        Message(Msg);
    end;

    procedure RepairSalesLineDescriptions(var SalesLine: Record "Sales Line")
    var
        ItemRefRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
        FullDesc: Text;
        PartNo: Text;
        FinalPurchLongDesc: Text;
        SalesHeader: Record "Sales Header";
    begin
        if SalesLine."Document No." = '' then
            Error('Select a sales quote line first.');

        if not TryOpenRecordRef(ItemRefRecRef, 50013) then
            Error('Table 50013 cannot be opened in this tenant.');

        for i := 1 to ItemRefRecRef.FieldCount() do begin
            FldRef := ItemRefRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(SalesLine."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(SalesLine."Line No.");
        end;

        if not ItemRefRecRef.FindFirst() then begin
            ItemRefRecRef.Close();
            Error('No Table 50013 record found for document %1 line %2.', SalesLine."Document No.", SalesLine."Line No.");
        end;

        FullDesc := GetRecordRefLongDescription(ItemRefRecRef);
        PartNo := GetRecordRefReferenceNo(ItemRefRecRef);

        if FullDesc = '' then
            Error('Table 50013 record exists, but Long Description is blank for document %1 line %2.', SalesLine."Document No.", SalesLine."Line No.");

        SetSalesLineDescriptionTargets(SalesLine, FullDesc);
        if PartNo <> '' then
            SalesLine."Item Reference No." := CopyStr(PartNo, 1, MaxStrLen(SalesLine."Item Reference No."));
        SalesLine.Modify(false);
        ForcePersistSalesLinePurchLongDesc(SalesLine."Document Type", SalesLine."Document No.", SalesLine."Line No.", FullDesc);

        if not SalesHeader.Get(SalesLine."Document Type", SalesLine."Document No.") then
            Clear(SalesHeader);
        UpdateItemRefFields(ItemRefRecRef, SalesLine, SalesHeader, PartNo, GetSalesLineFieldText(SalesLine, 'brand'), FullDesc, GetSalesLineIntegerVal(SalesLine, 'cust'), GetSalesLineIntegerVal(SalesLine, 'lead time'));
        ItemRefRecRef.Modify(false);
        ItemRefRecRef.Close();

        FinalPurchLongDesc := GetPersistedSalesLineFieldText(SalesLine."Document Type", SalesLine."Document No.", SalesLine."Line No.", 50011);

        Message('Repaired APSS line descriptions for %1 line %2. APSS Purch. Long Desc now: %3', SalesLine."Document No.", SalesLine."Line No.", FinalPurchLongDesc);
    end;

    procedure UpdateAllItemRefContactsForQuote(var CurrentLine: Record "Sales Line")
    var
        SalesLine: Record "Sales Line";
        CountUpdated: Integer;
        CountSkipped: Integer;
        PartNo: Text;
        BrandText: Text;
        FullDesc: Text;
        CustLineNo: Integer;
        LeadTimeWeeks: Integer;
    begin
        if CurrentLine."Document No." = '' then
            Error('Select a sales quote line first.');

        SalesLine.Reset();
        SalesLine.SetRange("Document Type", CurrentLine."Document Type");
        SalesLine.SetRange("Document No.", CurrentLine."Document No.");
        SalesLine.SetRange(Type, SalesLine.Type::Item);

        if not SalesLine.FindSet() then
            Error('No item lines found for %1.', CurrentLine."Document No.");

        repeat
            PartNo := SalesLine."Item Reference No.";
            if PartNo = '' then
                PartNo := GetSourcingReferenceNoForSalesLine(SalesLine);

            FullDesc := GetSourcingLongDescriptionForSalesLine(SalesLine);
            if FullDesc = '' then
                FullDesc := GetSalesLineFieldText(SalesLine, 'description 2');
            if FullDesc = '' then
                FullDesc := SalesLine.Description;

            if (PartNo <> '') or (FullDesc <> '') then begin
                BrandText := GetSalesLineFieldText(SalesLine, 'brand');
                CustLineNo := GetSalesLineIntegerVal(SalesLine, 'cust');
                LeadTimeWeeks := GetSalesLineIntegerVal(SalesLine, 'lead time');

                ApplyPopupEquivalentSalesLineFields(SalesLine, PartNo, FullDesc, GetSourcingUnitOfMeasureForSalesLine(SalesLine));
                SalesLine.Modify(false);
                PopulateItemRefContact(SalesLine, PartNo, BrandText, FullDesc, CustLineNo, LeadTimeWeeks);
                CountUpdated += 1;
            end else
                CountSkipped += 1;
        until SalesLine.Next() = 0;

        Message('Updated APSS item ref contact records and Sales Line popup-equivalent fields for %1 line(s). Skipped %2 line(s).', CountUpdated, CountSkipped);
    end;

    procedure OpenPrefilledItemRefContact(var SalesLine: Record "Sales Line")
    var
        DialogPage: Page "APSS Update Item Ref Contact";
        SalesHeader: Record "Sales Header";
        PartNo: Text;
        FullDesc: Text;
        UomCode: Code[10];
        ShipMethod: Code[10];
        IncotermLocation: Text;
        BrandText: Text;
        CustLineNo: Integer;
        LeadTimeWeeks: Integer;
        CustomerNo: Code[20];
        CustomerName: Text[100];
        ContactNo: Code[20];
        ContactName: Text[100];
        ItemDescription: Text[100];
    begin
        if SalesLine."Document No." = '' then
            Error('Select a sales quote line first.');

        if not SalesHeader.Get(SalesLine."Document Type", SalesLine."Document No.") then
            Error('Sales header %1 was not found.', SalesLine."Document No.");

        PartNo := GetSourcingReferenceNoForSalesLine(SalesLine);
        if PartNo = '' then
            PartNo := SalesLine."Item Reference No.";

        FullDesc := GetSourcingLongDescriptionForSalesLine(SalesLine);
        if FullDesc = '' then
            FullDesc := GetSalesLineFieldText(SalesLine, 'apss description');
        if FullDesc = '' then
            FullDesc := GetSalesLineFieldText(SalesLine, 'description 2');
        if FullDesc = '' then
            FullDesc := SalesLine.Description;

        UomCode := GetSourcingUnitOfMeasureForSalesLine(SalesLine);
        ShipMethod := CopyStr(GetSalesLineFieldText(SalesLine, 'shipment method'), 1, 10);
        if ShipMethod = '' then
            ShipMethod := SalesHeader."Shipment Method Code";
        if ShipMethod = '' then
            ShipMethod := 'FCA';

        IncotermLocation := GetSalesLineFieldText(SalesLine, 'incoterm');
        if IncotermLocation = '' then
            IncotermLocation := 'Singapore';

        CustomerNo := SalesHeader."Sell-to Customer No.";
        CustomerName := SalesHeader."Sell-to Customer Name";
        ContactNo := SalesHeader."Sell-to Contact No.";
        ContactName := SalesHeader."Sell-to Contact";
        ItemDescription := SalesLine.Description;

        DialogPage.SetDefaults(
            SalesLine."Document No.",
            CustomerNo,
            CustomerName,
            ContactNo,
            ContactName,
            SalesLine."No.",
            ItemDescription,
            UomCode,
            PartNo,
            FullDesc,
            ShipMethod,
            IncotermLocation);

        if DialogPage.RunModal() <> Action::OK then
            exit;

        DialogPage.GetValues(PartNo, FullDesc, UomCode, ShipMethod, IncotermLocation);
        if PartNo = '' then
            Error('Reference No. is required.');
        if FullDesc = '' then
            Error('Long Description is required.');

        BrandText := GetSalesLineFieldText(SalesLine, 'brand');
        CustLineNo := GetSalesLineIntegerVal(SalesLine, 'cust');
        LeadTimeWeeks := GetSalesLineIntegerVal(SalesLine, 'lead time');

        ApplyPopupEquivalentSalesLineFields(SalesLine, PartNo, FullDesc, UomCode);
        SetSalesLineTextFieldByName(SalesLine, 'shipmentmethod', ShipMethod);
        SetSalesLineTextFieldByName(SalesLine, 'incoterm', IncotermLocation);
        SalesLine.Modify(false);

        PopulateItemRefContact(SalesLine, PartNo, BrandText, FullDesc, CustLineNo, LeadTimeWeeks);
        Message('Updated APSS item ref contact for %1 line %2.', SalesLine."Document No.", SalesLine."Line No.");
    end;

    procedure ShowPopupCopyValues(var SalesLine: Record "Sales Line")
    var
        PartNo: Text;
        FullDesc: Text;
        UomCode: Code[10];
        ShipMethod: Code[10];
        IncotermLocation: Text;
    begin
        if SalesLine."Document No." = '' then
            Error('Select a sales quote line first.');

        PartNo := GetSourcingReferenceNoForSalesLine(SalesLine);
        if PartNo = '' then
            PartNo := SalesLine."Item Reference No.";

        FullDesc := GetSourcingLongDescriptionForSalesLine(SalesLine);
        if FullDesc = '' then
            FullDesc := GetSalesLineFieldText(SalesLine, 'apss description');
        if FullDesc = '' then
            FullDesc := GetSalesLineFieldText(SalesLine, 'description 2');
        if FullDesc = '' then
            FullDesc := SalesLine.Description;

        UomCode := GetSourcingUnitOfMeasureForSalesLine(SalesLine);
        ShipMethod := CopyStr(GetSalesLineFieldText(SalesLine, 'shipment method'), 1, 10);
        if ShipMethod = '' then
            ShipMethod := 'FCA';

        IncotermLocation := GetSalesLineFieldText(SalesLine, 'incoterm');
        if IncotermLocation = '' then
            IncotermLocation := 'Singapore';

        Message(
            'Copy these values into the standard Update Item Ref. Contact popup:\\Reference No.: %1\\Long Description: %2\\Unit of Measure Code: %3\\Shipment Method: %4\\Incoterm Location: %5',
            PartNo,
            FullDesc,
            UomCode,
            ShipMethod,
            IncotermLocation);
    end;

    procedure ShowPopupSourceProbe(var SalesLine: Record "Sales Line")
    var
        Msg: Text;
    begin
        if SalesLine."Document No." = '' then
            Error('Select a sales quote line first.');

        Msg := 'APSS popup source probe\' +
               'Document: ' + Format(SalesLine."Document Type") + ' ' + SalesLine."Document No." + '\' +
               'Line No.: ' + Format(SalesLine."Line No.") + '\' +
               'Item No.: ' + SalesLine."No." + '\' +
               'Item Reference No.: ' + SalesLine."Item Reference No." + '\\' +
               '--- Sales Line all APSS/custom fields ---\' +
               GetRecordFieldDiagnostics(Database::"Sales Line", SalesLine.RecordId(), false) +
               '\\--- Table 50013 all fields for this document/line ---\' +
               GetTable50013AllFieldsDiagnostics(SalesLine) +
               '\\--- Standard Item Reference records ---\' +
               GetStandardItemReferenceDiagnostics(SalesLine);

        Message(Msg);
    end;

    procedure ForcePopupLongDescForLine(var SalesLine: Record "Sales Line")
    var
        FullDesc: Text;
        PersistedValue: Text;
        Trace: Text;
    begin
        FullDesc := GetSourcingLongDescriptionForSalesLine(SalesLine);
        if FullDesc = '' then
            Error('No source Long Description found in table 50013 for %1 line %2.', SalesLine."Document No.", SalesLine."Line No.");

        Trace := ForcePersistSalesLinePurchLongDescTrace(SalesLine."Document Type", SalesLine."Document No.", SalesLine."Line No.", FullDesc);
        Commit();

        PersistedValue := GetPersistedSalesLineFieldText(SalesLine."Document Type", SalesLine."Document No.", SalesLine."Line No.", 50011);
        if PersistedValue = '' then
            Error('FlowField 50011 still calculates blank after source repair. Source value was: %1\\Trace:\%2', FullDesc, Trace);

        Message('FlowField 50011 calculates as: %1\\Trace:\%2', PersistedValue, Trace);
    end;

    procedure ShowCustomSourceScan(var SalesLine: Record "Sales Line")
    var
        TableNo: Integer;
        OutText: Text;
    begin
        if SalesLine."Document No." = '' then
            Error('Select a sales quote line first.');

        OutText := 'APSS custom source scan\' +
                   'Document: ' + SalesLine."Document No." + '\' +
                   'Line No.: ' + Format(SalesLine."Line No.") + '\' +
                   'Item No.: ' + SalesLine."No." + '\' +
                   'Item Reference No.: ' + SalesLine."Item Reference No." + '\\';

        for TableNo := 50000 to 50150 do begin
            AppendCustomTableExactLineMatches(TableNo, SalesLine, OutText);
            if StrLen(OutText) > 7000 then begin
                OutText += '\Output truncated at 7000 chars.';
                break;
            end;
        end;

        Message(OutText);
    end;

    procedure ShowSalesLineField50011Metadata()
    var
        FieldRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        OutText: Text;
    begin
        FieldRecRef.Open(Database::Field);
        FieldRecRef.Field(1).SetRange(Database::"Sales Line");
        FieldRecRef.Field(2).SetRange(50011);

        if not FieldRecRef.FindFirst() then begin
            FieldRecRef.Close();
            Error('Field metadata not found for Sales Line field 50011.');
        end;

        OutText := 'Sales Line field 50011 metadata\';
        for i := 1 to FieldRecRef.FieldCount() do begin
            FldRef := FieldRecRef.FieldIndex(i);
            if Format(FldRef.Value) <> '' then
                OutText += Format(FldRef.Number) + ' | ' + FldRef.Name + ' | ' + Format(FldRef.Type) + ' | "' + CopyStr(Format(FldRef.Value), 1, 500) + '"\';
        end;

        FieldRecRef.Close();
        Message(OutText);
    end;

    local procedure AppendCustomTableMatches(TableNo: Integer; var SalesLine: Record "Sales Line"; var OutText: Text)
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
    begin
        if not TryOpenRecordRef(RecRef, TableNo) then
            exit;

        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);

            if ((FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text)) and (SalesLine."Document No." <> '') then begin
                if FieldNameClean.Contains('document') or FieldNameClean.Contains('salesorder') or FieldNameClean.Contains('salesquote') or FieldNameClean.Contains('quote') or FieldNameClean.Contains('analysis') then
                    AppendFilteredTableRecords(TableNo, i, SalesLine."Document No.", OutText);
            end;

            if ((FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text)) and (SalesLine."No." <> '') then begin
                if (FieldNameClean = 'no') or FieldNameClean.Contains('itemno') or FieldNameClean.Contains('apssitem') then
                    AppendFilteredTableRecords(TableNo, i, SalesLine."No.", OutText);
            end;

            if ((FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text)) and (SalesLine."Item Reference No." <> '') then begin
                if FieldNameClean.Contains('reference') or FieldNameClean.Contains('refno') or FieldNameClean.Contains('part') then
                    AppendFilteredTableRecords(TableNo, i, SalesLine."Item Reference No.", OutText);
            end;

            if (FldRef.Type = FieldType::Integer) and (SalesLine."Line No." <> 0) then begin
                if FieldNameClean.Contains('line') then
                    AppendFilteredTableRecordsInteger(TableNo, i, SalesLine."Line No.", OutText);
            end;

            if StrLen(OutText) > 7000 then
                break;
        end;

        RecRef.Close();
    end;

    local procedure AppendCustomTableExactLineMatches(TableNo: Integer; var SalesLine: Record "Sales Line"; var OutText: Text)
    var
        RecRef: RecordRef;
        DocFldRef: FieldRef;
        LineFldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
        HasDocField: Boolean;
        HasLineField: Boolean;
        Count: Integer;
    begin
        if StrLen(OutText) > 7000 then
            exit;
        if not TryOpenRecordRef(RecRef, TableNo) then
            exit;

        for i := 1 to RecRef.FieldCount() do begin
            FieldNameClean := CleanFieldName(RecRef.FieldIndex(i).Name);
            if not HasDocField then
                if FieldNameClean.Contains('document') or FieldNameClean.Contains('salesorder') or FieldNameClean.Contains('salesquote') or FieldNameClean.Contains('quote') or FieldNameClean.Contains('analysis') then begin
                    DocFldRef := RecRef.FieldIndex(i);
                    if (DocFldRef.Type = FieldType::Code) or (DocFldRef.Type = FieldType::Text) then
                        HasDocField := true;
                end;
            if not HasLineField then
                if FieldNameClean.Contains('line') then begin
                    LineFldRef := RecRef.FieldIndex(i);
                    if LineFldRef.Type = FieldType::Integer then
                        HasLineField := true;
                end;
        end;

        if HasDocField and HasLineField then begin
            DocFldRef.SetRange(SalesLine."Document No.");
            LineFldRef.SetRange(SalesLine."Line No.");
            if RecRef.FindSet() then begin
                OutText += '\--- Table ' + Format(TableNo) + ' exact match ' + DocFldRef.Name + '="' + SalesLine."Document No." + '", ' + LineFldRef.Name + '="' + Format(SalesLine."Line No.") + '" ---\';
                repeat
                    Count += 1;
                    AppendRecordNonEmptyFields(RecRef, OutText);
                until (RecRef.Next() = 0) or (Count >= 3) or (StrLen(OutText) > 7000);
            end;
        end;

        RecRef.Close();
    end;

    local procedure AppendFilteredTableRecords(TableNo: Integer; FieldIndex: Integer; FilterValue: Text; var OutText: Text)
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        Count: Integer;
    begin
        if StrLen(OutText) > 7000 then
            exit;
        if not TryOpenRecordRef(RecRef, TableNo) then
            exit;

        FldRef := RecRef.FieldIndex(FieldIndex);
        FldRef.SetRange(FilterValue);

        if RecRef.FindSet() then begin
            OutText += '\--- Table ' + Format(TableNo) + ' matched on ' + FldRef.Name + '="' + FilterValue + '" ---\';
            repeat
                Count += 1;
                AppendRecordNonEmptyFields(RecRef, OutText);
            until (RecRef.Next() = 0) or (Count >= 2) or (StrLen(OutText) > 7000);
        end;

        RecRef.Close();
    end;

    local procedure AppendFilteredTableRecordsInteger(TableNo: Integer; FieldIndex: Integer; FilterValue: Integer; var OutText: Text)
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        Count: Integer;
    begin
        if StrLen(OutText) > 7000 then
            exit;
        if not TryOpenRecordRef(RecRef, TableNo) then
            exit;

        FldRef := RecRef.FieldIndex(FieldIndex);
        FldRef.SetRange(FilterValue);

        if RecRef.FindSet() then begin
            OutText += '\--- Table ' + Format(TableNo) + ' matched on ' + FldRef.Name + '="' + Format(FilterValue) + '" ---\';
            repeat
                Count += 1;
                AppendRecordNonEmptyFields(RecRef, OutText);
            until (RecRef.Next() = 0) or (Count >= 2) or (StrLen(OutText) > 7000);
        end;

        RecRef.Close();
    end;

    local procedure AppendRecordNonEmptyFields(var RecRef: RecordRef; var OutText: Text)
    var
        FldRef: FieldRef;
        i: Integer;
        ValueText: Text;
    begin
        OutText += 'Record:\';
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            if FldRef.Class = FieldClass::Normal then begin
                ValueText := CopyStr(Format(FldRef.Value), 1, 160);
                if ValueText <> '' then
                    OutText += Format(FldRef.Number) + ' | ' + FldRef.Name + ' | ' + Format(FldRef.Type) + ' | "' + ValueText + '"\';
            end;
            if StrLen(OutText) > 7000 then
                exit;
        end;
    end;

    local procedure GetSourcingLongDescriptionForSalesLine(var SalesLine: Record "Sales Line"): Text
    var
        ItemRefRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
        FullDesc: Text;
    begin
        if not TryOpenRecordRef(ItemRefRecRef, 50013) then
            exit('');

        for i := 1 to ItemRefRecRef.FieldCount() do begin
            FldRef := ItemRefRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(SalesLine."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(SalesLine."Line No.");
        end;

        if ItemRefRecRef.FindFirst() then
            FullDesc := GetRecordRefLongDescription(ItemRefRecRef);

        ItemRefRecRef.Close();
        exit(FullDesc);
    end;

    local procedure GetSourcingReferenceNoForSalesLine(var SalesLine: Record "Sales Line"): Text
    var
        ItemRefRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
        PartNo: Text;
    begin
        if not TryOpenRecordRef(ItemRefRecRef, 50013) then
            exit('');

        for i := 1 to ItemRefRecRef.FieldCount() do begin
            FldRef := ItemRefRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(SalesLine."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(SalesLine."Line No.");
        end;

        if ItemRefRecRef.FindFirst() then
            PartNo := GetRecordRefReferenceNo(ItemRefRecRef);

        ItemRefRecRef.Close();
        exit(PartNo);
    end;

    local procedure GetSourcingUnitOfMeasureForSalesLine(var SalesLine: Record "Sales Line"): Code[10]
    var
        ItemRefRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
        UomCode: Code[10];
    begin
        if not TryOpenRecordRef(ItemRefRecRef, 50013) then
            exit(SalesLine."Unit of Measure Code");

        for i := 1 to ItemRefRecRef.FieldCount() do begin
            FldRef := ItemRefRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(SalesLine."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(SalesLine."Line No.");
        end;

        if ItemRefRecRef.FindFirst() then
            UomCode := GetRecordRefUnitOfMeasure(ItemRefRecRef);

        ItemRefRecRef.Close();
        if UomCode <> '' then
            exit(UomCode);
        exit(SalesLine."Unit of Measure Code");
    end;

    local procedure GetRecordRefUnitOfMeasure(var RecRef: RecordRef): Code[10]
    var
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
    begin
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'unitofmeasurecode') or (FieldNameClean = 'uomcode') or (FieldNameClean = 'uom') then
                if Format(FldRef.Value) <> '' then
                    exit(CopyStr(Format(FldRef.Value), 1, 10));
        end;
        exit('');
    end;

    local procedure ApplyPopupEquivalentSalesLineFields(var SalesLine: Record "Sales Line"; PartNo: Text; FullDesc: Text; UomCode: Code[10])
    var
        SalesHeader: Record "Sales Header";
        RecRef: RecordRef;
        FldRef: FieldRef;
        CustomerNo: Code[20];
    begin
        if (PartNo = '') and (FullDesc = '') then
            exit;

        if SalesHeader.Get(SalesLine."Document Type", SalesLine."Document No.") then
            CustomerNo := SalesHeader."Sell-to Customer No."
        else
            CustomerNo := SalesLine."Sell-to Customer No.";

        if PartNo <> '' then begin
            SalesLine."Item Reference No." := CopyStr(PartNo, 1, MaxStrLen(SalesLine."Item Reference No."));
            SalesLine."Item Reference Type" := SalesLine."Item Reference Type"::Customer;
            SalesLine."Item Reference Type No." := CustomerNo;
        end;

        if (UomCode <> '') and (SalesLine."Unit of Measure Code" = '') then
            SalesLine.Validate("Unit of Measure Code", UomCode);

        RecRef.GetTable(SalesLine);
        SetSalesLineTextFieldIfNormal(RecRef, 50000, FullDesc);
        SetSalesLineTextFieldIfNormal(RecRef, 50008, PartNo);
        SetSalesLineTextFieldIfNormal(RecRef, 50009, PartNo);
        SetSalesLineTextFieldIfNormal(RecRef, 50010, PartNo);
        SetSalesLineTextFieldIfNormal(RecRef, 5725, PartNo);
        SetSalesLineTextFieldIfNormal(RecRef, 5726, UomCode);
        SetSalesLineTextFieldIfNormal(RecRef, 5728, CustomerNo);

        if FullDesc <> '' then begin
            SetSalesLineTextFieldIfNormal(RecRef, 12, FullDesc);
            SetSalesLineTextFieldIfNormal(RecRef, 50000, FullDesc);
        end;

        RecRef.SetTable(SalesLine);
    end;

    local procedure SetSalesLineTextFieldIfNormal(var RecRef: RecordRef; FieldNo: Integer; ValueText: Text)
    var
        FldRef: FieldRef;
    begin
        if ValueText = '' then
            exit;
        if not TryGetFieldRef(RecRef, FldRef, FieldNo) then
            exit;
        if FldRef.Class <> FieldClass::Normal then
            exit;
        if (FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text) then
            FldRef.Value := CopyStr(ValueText, 1, FldRef.Length);
    end;

    local procedure SetSalesLineTextFieldByName(var SalesLine: Record "Sales Line"; FieldNamePattern: Text; ValueText: Text)
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
    begin
        if ValueText = '' then
            exit;

        RecRef.GetTable(SalesLine);
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if FieldNameClean.Contains(FieldNamePattern) and (FldRef.Class = FieldClass::Normal) then
                if (FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text) then begin
                    FldRef.Value := CopyStr(ValueText, 1, FldRef.Length);
                    RecRef.SetTable(SalesLine);
                    exit;
                end;
        end;
    end;

    local procedure GetRecordRefLongDescription(var RecRef: RecordRef): Text
    var
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
    begin
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'longdescription') or FieldNameClean.Contains('longdesc') then
                if Format(FldRef.Value) <> '' then
                    exit(Format(FldRef.Value));
        end;
        exit('');
    end;

    local procedure GetRecordRefReferenceNo(var RecRef: RecordRef): Text
    var
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
    begin
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'itemreferenceno') or (FieldNameClean = 'referenceno') or (FieldNameClean = 'refno') then
                if Format(FldRef.Value) <> '' then
                    exit(Format(FldRef.Value));
        end;
        exit('');
    end;

    local procedure SetSalesLineDescriptionTargets(var SalesLine: Record "Sales Line"; FullDesc: Text)
    var
        SalesLineRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
    begin
        SalesLineRecRef.GetTable(SalesLine);
        for i := 1 to SalesLineRecRef.FieldCount() do begin
            FldRef := SalesLineRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if ((FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text)) and IsSalesLineDescriptionTarget(FieldNameClean) then
                FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
        end;
        if HasFieldNo(SalesLineRecRef, 50011) then begin
            FldRef := SalesLineRecRef.Field(50011);
            if (FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text) then
                FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
        end;
        SalesLineRecRef.SetTable(SalesLine);
    end;

    local procedure ForcePersistSalesLinePurchLongDesc(DocumentType: Enum "Sales Document Type"; DocumentNo: Code[20]; LineNo: Integer; FullDesc: Text)
    var
        SalesLineDb: Record "Sales Line";
        RecRef: RecordRef;
        FldRef: FieldRef;
    begin
        if FullDesc = '' then
            exit;
        if not SalesLineDb.Get(DocumentType, DocumentNo, LineNo) then
            exit;

        RecRef.GetTable(SalesLineDb);
        if HasFieldNo(RecRef, 50200) then begin
            FldRef := RecRef.Field(50200);
            if FldRef.Type = FieldType::Boolean then
                FldRef.Value := true;
        end;
        FldRef := RecRef.Field(50011);
        if (FldRef.Type = FieldType::Code) or (FldRef.Type = FieldType::Text) then begin
            FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
            RecRef.Modify(false);
        end;
    end;

    local procedure ForcePersistSalesLinePurchLongDescTrace(DocumentType: Enum "Sales Document Type"; DocumentNo: Code[20]; LineNo: Integer; FullDesc: Text): Text
    var
        SalesLineDb: Record "Sales Line";
        RecRef: RecordRef;
        FldRef: FieldRef;
        Trace: Text;
    begin
        if not SalesLineDb.Get(DocumentType, DocumentNo, LineNo) then
            exit('Sales Line not found.');

        Trace += 'Before=' + GetPersistedSalesLineFieldText(DocumentType, DocumentNo, LineNo, 50011) + '\';

        RecRef.GetTable(SalesLineDb);
        if HasFieldNo(RecRef, 50200) then begin
            FldRef := RecRef.Field(50200);
            if FldRef.Type = FieldType::Boolean then
                FldRef.Value := true;
        end;
        FldRef := RecRef.Field(50011);
        Trace += 'Field50011 name=' + FldRef.Name + ', type=' + Format(FldRef.Type) + ', class=' + Format(FldRef.Class) + ', len=' + Format(FldRef.Length) + '\';
        FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
        Trace += 'After assign in RecordRef=' + CopyStr(Format(FldRef.Value), 1, 250) + '\';

        RecRef.Modify(false);
        FldRef := RecRef.Field(50011);
        Trace += 'After RecRef.Modify(false), same RecRef=' + CopyStr(Format(FldRef.Value), 1, 250) + '\';
        Trace += 'After RecRef.Modify(false), CalcField reload=' + GetPersistedSalesLineFieldText(DocumentType, DocumentNo, LineNo, 50011) + '\';

        if SalesLineDb.Get(DocumentType, DocumentNo, LineNo) then begin
            RecRef.GetTable(SalesLineDb);
            FldRef := RecRef.Field(50011);
            FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
            RecRef.SetTable(SalesLineDb);
            SalesLineDb.Modify(false);
            Trace += 'After SetTable+SalesLine.Modify(false), CalcField reload=' + GetPersistedSalesLineFieldText(DocumentType, DocumentNo, LineNo, 50011) + '\';
        end;

        if SalesLineDb.Get(DocumentType, DocumentNo, LineNo) then begin
            RecRef.GetTable(SalesLineDb);
            FldRef := RecRef.Field(50011);
            FldRef.Value := CopyStr(FullDesc, 1, FldRef.Length);
            RecRef.SetTable(SalesLineDb);
            SalesLineDb.Modify(true);
            Trace += 'After SetTable+SalesLine.Modify(true), CalcField reload=' + GetPersistedSalesLineFieldText(DocumentType, DocumentNo, LineNo, 50011) + '\';
        end;

        exit(Trace);
    end;

    local procedure GetPersistedSalesLineFieldText(DocumentType: Enum "Sales Document Type"; DocumentNo: Code[20]; LineNo: Integer; FieldNo: Integer): Text
    var
        SalesLineDb: Record "Sales Line";
        RecRef: RecordRef;
        FldRef: FieldRef;
    begin
        if not SalesLineDb.Get(DocumentType, DocumentNo, LineNo) then
            exit('');

        RecRef.GetTable(SalesLineDb);
        FldRef := RecRef.Field(FieldNo);
        if FldRef.Class = FieldClass::FlowField then
            FldRef.CalcField();
        exit(Format(FldRef.Value));
    end;

    local procedure HasFieldNo(var RecRef: RecordRef; FieldNo: Integer): Boolean
    var
        FldRef: FieldRef;
    begin
        if TryGetFieldRef(RecRef, FldRef, FieldNo) then
            exit(true);
        exit(false);
    end;

    [TryFunction]
    local procedure TryGetFieldRef(var RecRef: RecordRef; var FldRef: FieldRef; FieldNo: Integer)
    begin
        FldRef := RecRef.Field(FieldNo);
    end;

    local procedure GetRecordFieldDiagnostics(TableNo: Integer; RecId: RecordId; RelatedOnly: Boolean): Text
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        OutText: Text;
        FieldNameClean: Text;
        FieldValue: Text;
    begin
        RecRef.Open(TableNo);
        RecRef.Get(RecId);

        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);

            if (not RelatedOnly) or IsDiagnosticField(FieldNameClean) then begin
                if FldRef.Class = FieldClass::FlowField then
                    FldRef.CalcField();
                FieldValue := CopyStr(Format(FldRef.Value), 1, 250);
                OutText +=
                    Format(FldRef.Number) + ' | ' +
                    FldRef.Name + ' | ' +
                    Format(FldRef.Type) + ' | "' +
                    FieldValue + '"\';
            end;
        end;

        RecRef.Close();
        exit(OutText);
    end;

    local procedure GetTable50013Diagnostics(var SalesLine: Record "Sales Line"): Text
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        Count: Integer;
        OutText: Text;
        FieldNameClean: Text;
    begin
        if not TryOpenRecordRef(RecRef, 50013) then
            exit('Table 50013 cannot be opened in this tenant.\');

        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);

            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(SalesLine."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(SalesLine."Line No.");
        end;

        if not RecRef.FindSet() then begin
            RecRef.Close();
            exit('No Table 50013 record found for this document/line.\');
        end;

        repeat
            Count += 1;
            OutText += 'Record #' + Format(Count) + '\';
            for i := 1 to RecRef.FieldCount() do begin
                FldRef := RecRef.FieldIndex(i);
                FieldNameClean := CleanFieldName(FldRef.Name);
                if IsDiagnosticField(FieldNameClean) or
                   (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or
                   (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or
                   (FieldNameClean = 'analysisno') or (FieldNameClean = 'lineno') or
                   (FieldNameClean = 'saleslineno') or (FieldNameClean = 'no') or
                   (FieldNameClean = 'itemno') then begin
                    OutText +=
                        Format(FldRef.Number) + ' | ' +
                        FldRef.Name + ' | ' +
                        Format(FldRef.Type) + ' | "' +
                        CopyStr(Format(FldRef.Value), 1, 250) + '"\';
                end;
            end;
        until (RecRef.Next() = 0) or (Count >= 3);

        RecRef.Close();
        exit(OutText);
    end;

    local procedure GetTable50013AllFieldsDiagnostics(var SalesLine: Record "Sales Line"): Text
    var
        RecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        Count: Integer;
        OutText: Text;
        FieldNameClean: Text;
    begin
        if not TryOpenRecordRef(RecRef, 50013) then
            exit('Table 50013 cannot be opened in this tenant.\');

        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'salesorderno') or (FieldNameClean = 'documentno') or (FieldNameClean = 'salesquoteno') or (FieldNameClean = 'quoteno') or (FieldNameClean = 'analysisno') then
                FldRef.SetRange(SalesLine."Document No.");
            if (FieldNameClean = 'lineno') or (FieldNameClean = 'saleslineno') then
                FldRef.SetRange(SalesLine."Line No.");
        end;

        if not RecRef.FindSet() then begin
            RecRef.Close();
            exit('No Table 50013 record found for this document/line.\');
        end;

        repeat
            Count += 1;
            OutText += 'Record #' + Format(Count) + '\';
            for i := 1 to RecRef.FieldCount() do begin
                FldRef := RecRef.FieldIndex(i);
                if FldRef.Class = FieldClass::Normal then
                    OutText +=
                        Format(FldRef.Number) + ' | ' +
                        FldRef.Name + ' | ' +
                        Format(FldRef.Type) + ' | "' +
                        CopyStr(Format(FldRef.Value), 1, 180) + '"\';
            end;
        until (RecRef.Next() = 0) or (Count >= 2);

        RecRef.Close();
        exit(OutText);
    end;

    local procedure GetStandardItemReferenceDiagnostics(var SalesLine: Record "Sales Line"): Text
    var
        ItemReference: Record "Item Reference";
        OutText: Text;
        Count: Integer;
    begin
        ItemReference.Reset();
        ItemReference.SetRange("Item No.", SalesLine."No.");
        if SalesLine."Item Reference No." <> '' then
            ItemReference.SetRange("Reference No.", SalesLine."Item Reference No.");

        if not ItemReference.FindSet() then
            exit('No standard Item Reference record found for this line item/reference.\');

        repeat
            Count += 1;
            OutText +=
                'Record #' + Format(Count) + '\' +
                'Item No.="' + ItemReference."Item No." + '"\' +
                'Reference No.="' + ItemReference."Reference No." + '"\' +
                'Reference Type="' + Format(ItemReference."Reference Type") + '"\' +
                'Reference Type No.="' + ItemReference."Reference Type No." + '"\' +
                'Unit of Measure="' + ItemReference."Unit of Measure" + '"\' +
                'Description="' + ItemReference.Description + '"\';
        until (ItemReference.Next() = 0) or (Count >= 5);

        exit(OutText);
    end;

    procedure FetchAndPreviewRfqLines(RfqNo: Code[50])
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        ResponseText: Text;
        JToken: JsonToken;
        JObject: JsonObject;
        ItemsToken: JsonToken;
        JArray: JsonArray;
        ItemToken: JsonToken;
        ItemObj: JsonObject;
        RfqLineBuffer: Record "APSS RFQ Line Buffer";
        Item: Record Item;
        i: Integer;
        Url: Text;
        PartNoText: Text;
        MatDesc: Text[100];
        UomCode: Code[10];
        MatchedItemNo: Code[20];
        SimilarityScore: Decimal;
        CandidateScore: Decimal;
        MatchReasonText: Text[250];
        CandidateReasonText: Text[250];
        CandidateItem: Record Item;
        HasExactPartMatch: Boolean;
    begin
        Setup.GetSetupRecord();
            
        Url := Setup."Middleware Base URL" + '/api/middleware/pull?rfq_no=' + RfqNo;
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', '1');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
        
        if not Client.Get(Url, Response) then
            Error('Failed to connect to Middleware at %1', Url);
            
        if not Response.IsSuccessStatusCode() then
            Error('Error response from Middleware: %1 %2', Response.HttpStatusCode(), Response.ReasonPhrase());
            
        Response.Content().ReadAs(ResponseText);
        
        if not JToken.ReadFrom(ResponseText) then
            Error('Invalid response JSON format from Middleware.');
            
        JObject := JToken.AsObject();
        if not JObject.Get('items', ItemsToken) then
            Error('No items found in response for RFQ %1', RfqNo);
            
        JArray := ItemsToken.AsArray();
        
        // Clear old buffer for this RFQ
        RfqLineBuffer.Reset();
        RfqLineBuffer.SetRange("RFQ No.", RfqNo);
        RfqLineBuffer.DeleteAll();
        
        for i := 0 to JArray.Count() - 1 do begin
            JArray.Get(i, ItemToken);
            ItemObj := ItemToken.AsObject();
            
            RfqLineBuffer.Init();
            RfqLineBuffer."RFQ No." := RfqNo;
            RfqLineBuffer."Line No." := i + 1;
            RfqLineBuffer."Material Code" := CopyStr(GetJsonValueAsText(ItemObj, 'material_code'), 1, 50);
            RfqLineBuffer."Material Description" := CopyStr(GetJsonValueAsText(ItemObj, 'description'), 1, 100);
            RfqLineBuffer."Long Description" := CopyStr(GetJsonValueAsText(ItemObj, 'long_description'), 1, 250);
            RfqLineBuffer."Part Number" := CopyStr(GetJsonValueAsText(ItemObj, 'part_number'), 1, 50);
            RfqLineBuffer.Manufacturer := CopyStr(GetJsonValueAsText(ItemObj, 'manufacturer'), 1, 100);
            RfqLineBuffer.UOM := CleanUomCode(GetJsonValueAsText(ItemObj, 'uom'));
            
            RfqLineBuffer.Quantity := ParseQtyTextToDecimal(GetJsonValueAsText(ItemObj, 'qty'));
            if RfqLineBuffer.Quantity <= 0 then
                RfqLineBuffer.Quantity := 1;
                
            PartNoText := RfqLineBuffer."Part Number";
            MatDesc := RfqLineBuffer."Material Description";
            
            // Perform BC-side matching logic
            MatchedItemNo := CopyStr(GetJsonValueAsText(ItemObj, 'bc_item_no'), 1, 20);
            SimilarityScore := 0;
            MatchReasonText := '';
            
            Item.Reset();
            if (MatchedItemNo <> '') and Item.Get(MatchedItemNo) then begin
                HasExactPartMatch := ItemHasExactPartReference(Item, PartNoText);
                SimilarityScore := EvaluateCandidateScore(
                    RfqLineBuffer."Material Description",
                    PartNoText,
                    RfqLineBuffer.Manufacturer,
                    Item,
                    HasExactPartMatch,
                    MatchReasonText);
                if SimilarityScore > 0 then
                    RfqLineBuffer."Matched Item No." := Item."No.";
            end;

            if FindBestFuzzyMatchLocally(
                RfqLineBuffer."Material Description",
                PartNoText,
                RfqLineBuffer.Manufacturer,
                CandidateItem,
                CandidateScore,
                CandidateReasonText)
            then begin
                if CandidateScore > SimilarityScore then begin
                    RfqLineBuffer."Matched Item No." := CandidateItem."No.";
                    SimilarityScore := CandidateScore;
                    MatchReasonText := CandidateReasonText;
                end;
            end;

            if SimilarityScore > 0 then
                RfqLineBuffer."Match Score" := Round(SimilarityScore * 100, 0.01)
            else begin
                RfqLineBuffer."Matched Item No." := '';
                RfqLineBuffer."Match Score" := 0;
            end;

            // Assign Match Status based on computed score
            if RfqLineBuffer."Match Score" >= 95 then begin
                RfqLineBuffer."Match Status" := RfqLineBuffer."Match Status"::"Auto-Link";
                if MatchReasonText <> '' then
                    RfqLineBuffer."Match Reason" := MatchReasonText
                else
                    RfqLineBuffer."Match Reason" := 'Matched automatically via high-confidence similarity';
            end else if RfqLineBuffer."Match Score" >= 40 then begin
                RfqLineBuffer."Match Status" := RfqLineBuffer."Match Status"::Review;
                if MatchReasonText <> '' then
                    RfqLineBuffer."Match Reason" := CopyStr(MatchReasonText + ' Review suggested.', 1, MaxStrLen(RfqLineBuffer."Match Reason"))
                else
                    RfqLineBuffer."Match Reason" := 'Fuzzy match found, review suggested';
            end else begin
                RfqLineBuffer."Match Status" := RfqLineBuffer."Match Status"::"Create Blank";
                RfqLineBuffer."Matched Item No." := '';
                RfqLineBuffer."Match Score" := 0;
                RfqLineBuffer."Match Reason" := 'No matching item found in database';
            end;
            
            RfqLineBuffer.Insert();
        end;
        
        Commit();
        
        RfqLineBuffer.Reset();
        RfqLineBuffer.SetRange("RFQ No.", RfqNo);
        Page.Run(Page::"APSS RFQ Line Preview", RfqLineBuffer);
    end;

    procedure OpenCachedOrFetchRfqPreview(RfqNo: Code[50])
    var
        RfqLineBuffer: Record "APSS RFQ Line Buffer";
    begin
        RfqLineBuffer.Reset();
        RfqLineBuffer.SetRange("RFQ No.", RfqNo);
        if RfqLineBuffer.FindFirst() then begin
            Page.Run(Page::"APSS RFQ Line Preview", RfqLineBuffer);
            exit;
        end;

        FetchAndPreviewRfqLines(RfqNo);
    end;

    procedure CreateQuoteFromRfqBuffer(RfqNo: Code[50])
    var
        Setup: Record "APSS Integration Setup";
        RfqBuffer: Record "APSS RFQ Buffer";
        RfqLineBuffer: Record "APSS RFQ Line Buffer";
        SalesHeader: Record "Sales Header";
        SalesLine: Record "Sales Line";
        Item: Record Item;
        Opportunity: Record Opportunity;
        ContBusRel: Record "Contact Business Relation";
        Contact: Record Contact;
        MarketingSetup: Record "Marketing Setup";
        OppEntry: Record "Opportunity Entry";
        Customer: Record Customer;
        CustomerNoToUse: Code[20];
        CreatedQuoteNo: Code[20];
        LineNo: Integer;
        ParsedDate: Date;
        ItemsCreated: Integer;
        ItemsLinked: Integer;
        IsNewItem: Boolean;

        // Variables for Attachments
        Client: HttpClient;
        Response: HttpResponseMessage;
        ResponseText: Text;
        JToken: JsonToken;
        JObject: JsonObject;
        RfqToken: JsonToken;
        RfqObj: JsonObject;
        AttachmentsToken: JsonToken;
        AttachmentsArray: JsonArray;
        AttachmentToken: JsonToken;
        AttachmentObj: JsonObject;
        AttName: Text;
        AttUrl: Text;
        AttClient: HttpClient;
        AttResponse: HttpResponseMessage;
        AttInStr: InStream;
        DocAttachment: Record "Document Attachment";
        ShipToAddr2: Record "Ship-to Address";
        i: Integer;
        Url: Text;
    begin
        Setup.GetSetupRecord();
            
        // Check if Sales Quote already exists; safely clear old quote if present
        SalesHeader.Reset();
        SalesHeader.SetRange("Document Type", SalesHeader."Document Type"::Quote);
        SalesHeader.SetRange("External Document No.", RfqNo);
        if SalesHeader.FindFirst() then begin
            DocAttachment.Reset();
            DocAttachment.SetRange("Table ID", Database::"Sales Header");
            DocAttachment.SetRange("Document Type", SalesHeader."Document Type");
            DocAttachment.SetRange("No.", SalesHeader."No.");
            if DocAttachment.FindSet() then
                DocAttachment.DeleteAll(false);

            SalesHeader."Opportunity No." := '';
            SalesHeader.Delete(false);
        end;

        // Dynamic Customer Resolution
        CustomerNoToUse := Setup."Default Customer No.";
        if RfqBuffer.Get(RfqNo) then begin
            if RfqBuffer.Portal = 'POSCO e-Pro' then begin
                Customer.Reset();
                Customer.SetFilter(Name, '@*POSCO*');
                if Customer.FindFirst() then
                    CustomerNoToUse := Customer."No.";
            end else if RfqBuffer.Portal = 'PTTEP FlashBuy' then begin
                Customer.Reset();
                Customer.SetFilter(Name, '@*PTTEP Energy*');
                if not Customer.FindFirst() then begin
                    Customer.SetFilter(Name, '@*PTTEP*');
                    Customer.FindFirst();
                end;
                CustomerNoToUse := Customer."No.";
            end;
        end;

        // Create Opportunity
        Opportunity.Init();
        Opportunity.Validate(Description, CopyStr(RfqBuffer.Subject, 1, MaxStrLen(Opportunity.Description)));
        
        ContBusRel.Reset();
        ContBusRel.SetRange("Link to Table", ContBusRel."Link to Table"::Customer);
        ContBusRel.SetRange("No.", CustomerNoToUse);
        if ContBusRel.FindFirst() then begin
            Opportunity.Validate("Contact Company No.", ContBusRel."Contact No.");
            Contact.Reset();
            Contact.SetRange("Company No.", ContBusRel."Contact No.");
            Contact.SetRange(Type, Contact.Type::Person);
            if Contact.FindFirst() then
                Opportunity.Validate("Contact No.", Contact."No.")
            else
                Opportunity.Validate("Contact No.", ContBusRel."Contact No.");
        end;

        if MarketingSetup.Get() then begin
            if MarketingSetup."Default Sales Cycle Code" <> '' then
                Opportunity.Validate("Sales Cycle Code", MarketingSetup."Default Sales Cycle Code");
        end;

        Opportunity.Insert(true);

        if Opportunity."Sales Cycle Code" <> '' then begin
            OppEntry.Init();
            OppEntry."Entry No." := GetNextOppEntryNo();
            OppEntry."Opportunity No." := Opportunity."No.";
            OppEntry."Sales Cycle Code" := Opportunity."Sales Cycle Code";
            OppEntry."Sales Cycle Stage" := 1;
            OppEntry.Active := true;
            OppEntry."Date of Change" := Today();
            OppEntry."Estimated Close Date" := Today();
            OppEntry.Insert(true);
        end;

        Opportunity.Status := Opportunity.Status::"In Progress";
        Opportunity.Modify(true);

        // Create Sales Header
        SalesHeader.Init();
        SalesHeader.SetHideValidationDialog(true);
        SalesHeader.Validate("Document Type", SalesHeader."Document Type"::Quote);
        SalesHeader.Insert(true);
        SalesHeader.Validate("Sell-to Customer No.", CustomerNoToUse);

        // Clear Ship-to Code if it no longer exists in Ship-to Address table
        if SalesHeader."Ship-to Code" <> '' then begin
            ShipToAddr2.Reset();
            ShipToAddr2.SetRange("Customer No.", CustomerNoToUse);
            ShipToAddr2.SetRange(Code, SalesHeader."Ship-to Code");
            if not ShipToAddr2.FindFirst() then
                SalesHeader."Ship-to Code" := '';
        end;

        SalesHeader.Validate("Salesperson Code", ''); // Leave blank per feedback
        SalesHeader."Opportunity No." := Opportunity."No.";
        SalesHeader.Validate("External Document No.", CopyStr(RfqNo, 1, MaxStrLen(SalesHeader."External Document No.")));
        SalesHeader.Validate("Your Reference", CopyStr(Opportunity.Description, 1, MaxStrLen(SalesHeader."Your Reference")));
        
        if RfqBuffer.Get(RfqNo) then begin
            if RfqBuffer.Subject <> '' then
                SalesHeader.SetWorkDescription(RfqBuffer.Subject);
            if RfqBuffer."Close Date" <> '' then begin
                ParsedDate := ParseDateText(RfqBuffer."Close Date");
                if ParsedDate < WorkDate() then
                    ParsedDate := WorkDate();
                if ParsedDate < Today() then
                    ParsedDate := Today();
                SalesHeader.Validate("Requested Delivery Date", ParsedDate);
            end;
        end;
        
        AssignSalesHeaderCustomFields(SalesHeader);
        SalesHeader.Modify(true);
        CreatedQuoteNo := SalesHeader."No.";

        // Link Sales Quote to Opportunity
        Opportunity."Sales Document Type" := Opportunity."Sales Document Type"::Quote;
        Opportunity."Sales Document No." := CreatedQuoteNo;
        Opportunity.Modify(true);

        LineNo := 10000;
        ItemsCreated := 0;
        ItemsLinked := 0;

        RfqLineBuffer.Reset();
        RfqLineBuffer.SetRange("RFQ No.", RfqNo);
        if RfqLineBuffer.FindSet() then begin
            repeat
                Item.Reset();
                IsNewItem := false;
                if (RfqLineBuffer."Matched Item No." <> '') and Item.Get(RfqLineBuffer."Matched Item No.") then begin
                    ItemsLinked += 1;
                end else begin
                    // Create new blank item card
                    Item.Init();
                    Item."No." := GetNewItemNo();
                    IsNewItem := true;
                    AssignDefaultCustomFields(Item, RfqLineBuffer.Manufacturer, RfqLineBuffer."Long Description");
                    Item.Insert(true);
                    
                    Item.Validate(Description, RfqLineBuffer."Material Description");
                    EnsureUnitOfMeasure(RfqLineBuffer.UOM);
                    EnsureItemUnitOfMeasure(Item."No.", RfqLineBuffer.UOM);
                    Item.Validate("Base Unit of Measure", RfqLineBuffer.UOM);
                    AssignDefaultPostingGroups(Item, CustomerNoToUse);
                    ItemsCreated += 1;
                end;

                Item.Validate(Blocked, false);
                AssignDefaultCustomFields(Item, RfqLineBuffer.Manufacturer, RfqLineBuffer."Long Description");
                
                if Item."Item Category Code" <> '' then begin
                    CopyDefaultDimensionsFromItemCategory(Item, Item."Item Category Code");
                end;
                
                Item.Modify(true);
                
                if IsNewItem then
                    SetItemApprovedDirectly(Item, false);

                if RfqLineBuffer."Part Number" <> '' then begin
                    EnsureItemReference(Item."No.", RfqLineBuffer."Part Number", RfqLineBuffer.Manufacturer, RfqLineBuffer.UOM, CustomerNoToUse);
                end;

                // Add Sales Line
                SalesLine.Init();
                SalesLine.Validate("Document Type", SalesLine."Document Type"::Quote);
                SalesLine.Validate("Document No.", CreatedQuoteNo);
                SalesLine.Validate("Line No.", LineNo);
                SalesLine.Validate(Type, SalesLine.Type::Item);
                SalesLine.Validate("No.", Item."No.");
                if RfqLineBuffer."Part Number" <> '' then begin
                    SalesLine.Validate("Item Reference No.", CopyStr(RfqLineBuffer."Part Number", 1, 50));
                end;
                SalesLine.Validate(Quantity, RfqLineBuffer.Quantity);
                SalesLine.Insert(true);

                PopulateSalesLineCustomFields(SalesLine, RfqLineBuffer.Manufacturer, RfqLineBuffer."Part Number", RfqLineBuffer."Long Description", 0, RfqLineBuffer."Line No.");
                ApplyPopupEquivalentSalesLineFields(SalesLine, RfqLineBuffer."Part Number", RfqLineBuffer."Long Description", RfqLineBuffer.UOM);
                SalesLine.Modify(false);
                
                PopulateItemRefContact(SalesLine, RfqLineBuffer."Part Number", RfqLineBuffer.Manufacturer, RfqLineBuffer."Long Description", RfqLineBuffer."Line No.", 0);
                
                LineNo += 10000;
            until RfqLineBuffer.Next() = 0;
        end;

        // ─── Attach RFQ Documents (Header Level) ─────────────────
        Url := Setup."Middleware Base URL" + '/api/middleware/pull?rfq_no=' + RfqNo;
        Clear(Client);
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', '1');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
        if Client.Get(Url, Response) then begin
            if Response.IsSuccessStatusCode() then begin
                Response.Content().ReadAs(ResponseText);
                if JToken.ReadFrom(ResponseText) then begin
                    JObject := JToken.AsObject();
                    if JObject.Get('rfq', RfqToken) then begin
                        RfqObj := RfqToken.AsObject();
                        if RfqObj.Get('attachments', AttachmentsToken) then begin
                            AttachmentsArray := AttachmentsToken.AsArray();
                            for i := 0 to AttachmentsArray.Count() - 1 do begin
                                AttachmentsArray.Get(i, AttachmentToken);
                                AttachmentObj := AttachmentToken.AsObject();
                                AttName := GetJsonValueAsText(AttachmentObj, 'name');
                                AttUrl := GetJsonValueAsText(AttachmentObj, 'url');
                                
                                if (AttName <> '') and (AttUrl <> '') then begin
                                    Clear(AttClient);
                                    AttClient.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', '1');
                                    if Setup."API Key" <> '' then
                                        AttClient.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
                                    if AttClient.Get(AttUrl, AttResponse) then begin
                                        if AttResponse.IsSuccessStatusCode() then begin
                                            AttResponse.Content().ReadAs(AttInStr);
                                            
                                            DocAttachment.Init();
                                            DocAttachment.Validate("Table ID", Database::"Sales Header");
                                            DocAttachment.Validate("Document Type", DocAttachment."Document Type"::Quote);
                                            DocAttachment.Validate("No.", CreatedQuoteNo);
                                            DocAttachment.Validate("Line No.", 0);
                                            
                                            DocAttachment.Reset();
                                            DocAttachment.SetRange("Table ID", Database::"Sales Header");
                                            DocAttachment.SetRange("Document Type", DocAttachment."Document Type"::Quote);
                                            DocAttachment.SetRange("No.", CreatedQuoteNo);
                                            DocAttachment.SetRange("Line No.", 0);
                                            if DocAttachment.FindLast() then
                                                DocAttachment.ID := DocAttachment.ID + 1
                                            else
                                                DocAttachment.ID := 1;
                                                
                                            DocAttachment."File Name" := CopyStr(GetFileNameWithoutExtension(AttName), 1, MaxStrLen(DocAttachment."File Name"));
                                            DocAttachment."File Extension" := CopyStr(GetFileExtension(AttName), 1, MaxStrLen(DocAttachment."File Extension"));
                                            
                                            if LowerCase(DocAttachment."File Extension") in ['jpg', 'jpeg', 'png', 'gif', 'bmp'] then
                                                DocAttachment."File Type" := DocAttachment."File Type"::Image
                                            else if LowerCase(DocAttachment."File Extension") = 'pdf' then
                                                DocAttachment."File Type" := DocAttachment."File Type"::PDF
                                            else if LowerCase(DocAttachment."File Extension") in ['doc', 'docx'] then
                                                DocAttachment."File Type" := DocAttachment."File Type"::Word
                                            else if LowerCase(DocAttachment."File Extension") in ['xls', 'xlsx'] then
                                                DocAttachment."File Type" := DocAttachment."File Type"::Excel
                                            else
                                                DocAttachment."File Type" := DocAttachment."File Type"::Other;
                                                
                                            DocAttachment."Document Reference ID".ImportStream(AttInStr, AttName);
                                            DocAttachment.Insert(true);
                                        end;
                                    end;
                                end;
                            end;
                        end;
                    end;
                end;
            end;
        end;

        if RfqBuffer.Get(RfqNo) then begin
            RfqBuffer."Sales Quote Created" := CreatedQuoteNo;
            RfqBuffer.Modify();
        end;

        SalesLine.Reset();
        SalesLine.SetRange("Document Type", SalesLine."Document Type"::Quote);
        SalesLine.SetRange("Document No.", CreatedQuoteNo);
        if SalesLine.FindFirst() then
            UpdateAllItemRefContactsForQuote(SalesLine);

        // Clean up preview buffer
        RfqLineBuffer.Reset();
        RfqLineBuffer.SetRange("RFQ No.", RfqNo);
        RfqLineBuffer.DeleteAll();

        Message('Sales Quote %1 created successfully!\\Summary:\- Total items: %2\- New Items Created: %3\- Existing Items Linked: %4',
            CreatedQuoteNo, RfqLineBuffer.Count(), ItemsCreated, ItemsLinked);
    end;

    local procedure IsDiagnosticField(FieldNameClean: Text): Boolean
    begin
        exit(
            FieldNameClean.Contains('desc') or
            FieldNameClean.Contains('description') or
            FieldNameClean.Contains('long') or
            FieldNameClean.Contains('purch') or
            FieldNameClean.Contains('spec') or
            FieldNameClean.Contains('ref') or
            FieldNameClean.Contains('brand') or
            FieldNameClean.Contains('part'));
    end;

    local procedure IsSalesLineDescriptionTarget(FieldNameClean: Text): Boolean
    begin
        exit(
            (FieldNameClean = 'description2') or
            (FieldNameClean = 'apssdescription') or
            FieldNameClean.Contains('longdescription') or
            FieldNameClean.Contains('longdesc') or
            FieldNameClean.Contains('purchlongdesc') or
            FieldNameClean.Contains('purchasedescription') or
            FieldNameClean.Contains('purchasedesc') or
            FieldNameClean.Contains('purchdesc'));
    end;

    local procedure GetNextOppEntryNo(): Integer
    var
        OppEntry: Record "Opportunity Entry";
    begin
        OppEntry.Reset();
        if OppEntry.FindLast() then
            exit(OppEntry."Entry No." + 1);
        exit(1);
    end;

    local procedure GetDiceSimilarity(Str1: Text; Str2: Text): Decimal
    var
        s1: Text;
        s2: Text;
        i: Integer;
        Intersection: Integer;
        Bigram: Text[2];
        Bigrams1: List of [Text[2]];
    begin
        s1 := LowerCase(DelChr(Str1, '=', ' -/.\,()[]{}'));
        s2 := LowerCase(DelChr(Str2, '=', ' -/.\,()[]{}'));
        
        if s1 = s2 then
            exit(1.0);
            
        if (StrLen(s1) < 2) or (StrLen(s2) < 2) then
            exit(0.0);
            
        for i := 1 to StrLen(s1) - 1 do begin
            Bigram := CopyStr(s1, i, 2);
            if not Bigrams1.Contains(Bigram) then
                Bigrams1.Add(Bigram);
        end;
        
        Intersection := 0;
        for i := 1 to StrLen(s2) - 1 do begin
            Bigram := CopyStr(s2, i, 2);
            if Bigrams1.Contains(Bigram) then begin
                Intersection += 1;
                Bigrams1.Remove(Bigram);
            end;
        end;
        
        exit((2.0 * Intersection) / (StrLen(s1) + StrLen(s2) - 2));
    end;

    local procedure FindBestFuzzyMatchLocally(MatDesc: Text[100]; PartNoText: Text; ManufacturerText: Text[100]; var BestItem: Record Item; var BestScore: Decimal; var BestReason: Text[250]): Boolean
    var
        Item: Record Item;
        ItemReference: Record "Item Reference";
        Score: Decimal;
        CandidateReason: Text[250];
    begin
        BestScore := 0;
        BestReason := '';
        
        // 1. First priority: score every exact part number candidate and keep the best fit
        if PartNoText <> '' then begin
            ItemReference.Reset();
            ItemReference.SetRange("Reference No.", PartNoText);
            if ItemReference.FindSet() then
                repeat
                    if Item.Get(ItemReference."Item No.") then begin
                        Score := EvaluateCandidateScore(MatDesc, PartNoText, ManufacturerText, Item, true, CandidateReason);
                        if Score > BestScore then begin
                            BestScore := Score;
                            BestItem := Item;
                            BestReason := CandidateReason;
                        end;
                    end;
                until ItemReference.Next() = 0;

            if StrLen(PartNoText) <= MaxStrLen(Item.GTIN) then begin
                Item.Reset();
                Item.SetRange(GTIN, PartNoText);
                if Item.FindSet() then
                    repeat
                        Score := EvaluateCandidateScore(MatDesc, PartNoText, ManufacturerText, Item, true, CandidateReason);
                        if Score > BestScore then begin
                            BestScore := Score;
                            BestItem := Item;
                            BestReason := CandidateReason;
                        end;
                    until Item.Next() = 0;
            end;
        end;

        // 2. Second priority: fuzzy match description with manufacturer/brand support
        Item.Reset();
        if Item.FindSet() then begin
            repeat
                Score := EvaluateCandidateScore(MatDesc, PartNoText, ManufacturerText, Item, false, CandidateReason);
                if Score > BestScore then begin
                    BestScore := Score;
                    BestItem := Item;
                    BestReason := CandidateReason;
                end;
            until Item.Next() = 0;
        end;
        
        exit(BestScore >= 0.40);
    end;

    local procedure EvaluateCandidateScore(MatDesc: Text; PartNoText: Text; ManufacturerText: Text; Item: Record Item; HasExactPartMatch: Boolean; var MatchReason: Text[250]): Decimal
    var
        DescScore: Decimal;
        ManufacturerScore: Decimal;
        Score: Decimal;
        ItemBrandText: Text;
        NormalizedInputDesc: Text;
        NormalizedItemDesc: Text;
    begin
        DescScore := GetDiceSimilarity(MatDesc, Item.Description);
        ItemBrandText := GetItemBrandLikeText(Item);
        if (ManufacturerText <> '') and (ItemBrandText <> '') then
            ManufacturerScore := GetDiceSimilarity(ManufacturerText, ItemBrandText)
        else
            ManufacturerScore := 0;

        NormalizedInputDesc := NormalizeComparableText(MatDesc);
        NormalizedItemDesc := NormalizeComparableText(Item.Description);

        if (NormalizedInputDesc <> '') and (NormalizedInputDesc = NormalizedItemDesc) then begin
            if HasExactPartMatch then
                Score := 1.0
            else
                Score := 0.97;

            MatchReason := BuildMatchReason(
                'Exact description match.',
                DescScore,
                ManufacturerScore,
                ManufacturerText,
                ItemBrandText,
                Score,
                MaxStrLen(MatchReason));
            exit(Score);
        end;

        if HasExactPartMatch then begin
            if DescScore >= 0.85 then
                Score := 0.96
            else if DescScore >= 0.65 then
                Score := 0.88 + (ManufacturerScore * 0.07)
            else if DescScore >= 0.45 then
                Score := 0.72 + (DescScore * 0.10) + (ManufacturerScore * 0.08)
            else
                Score := 0.55 + (ManufacturerScore * 0.10);

            if Score > 1.0 then
                Score := 1.0;

            MatchReason := BuildMatchReason(
                'Exact part number match.',
                DescScore,
                ManufacturerScore,
                ManufacturerText,
                ItemBrandText,
                Score,
                MaxStrLen(MatchReason));
            exit(Score);
        end;

        Score := (DescScore * 0.78) + (ManufacturerScore * 0.22);
        if (DescScore >= 0.88) and (ManufacturerScore >= 0.70) then
            Score += 0.05;
        if Score > 0.94 then
            Score := 0.94;

        MatchReason := BuildMatchReason(
            '',
            DescScore,
            ManufacturerScore,
            ManufacturerText,
            ItemBrandText,
            Score,
            MaxStrLen(MatchReason));

        exit(Score);
    end;

    local procedure BuildMatchReason(PrefixText: Text; DescScore: Decimal; ManufacturerScore: Decimal; ManufacturerText: Text; ItemBrandText: Text; FinalScore: Decimal; MaxLen: Integer): Text
    var
        ResultText: Text;
    begin
        ResultText := StrSubstNo('Description %1%', Format(Round(DescScore * 100, 1, '>')));

        if (ManufacturerText <> '') and (ItemBrandText <> '') then
            ResultText += StrSubstNo(', manufacturer %1%', Format(Round(ManufacturerScore * 100, 1, '>')));

        ResultText += StrSubstNo(' (Weighted score: %1%)', Format(Round(FinalScore * 100, 0.01)));

        ResultText += '.';

        if PrefixText <> '' then
            ResultText := PrefixText + ' ' + ResultText;

        exit(CopyStr(ResultText, 1, MaxLen));
    end;

    local procedure ItemHasExactPartReference(Item: Record Item; PartNoText: Text): Boolean
    var
        ItemReference: Record "Item Reference";
        NormalizedPartNo: Text;
    begin
        if PartNoText = '' then
            exit(false);

        NormalizedPartNo := NormalizeComparableText(PartNoText);
        if NormalizedPartNo = '' then
            exit(false);

        if NormalizeComparableText(Item.GTIN) = NormalizedPartNo then
            exit(true);

        ItemReference.Reset();
        ItemReference.SetRange("Item No.", Item."No.");
        if ItemReference.FindSet() then
            repeat
                if NormalizeComparableText(ItemReference."Reference No.") = NormalizedPartNo then
                    exit(true);
            until ItemReference.Next() = 0;

        exit(false);
    end;

    local procedure GetItemBrandLikeText(Item: Record Item): Text
    var
        ItemRecRef: RecordRef;
        FldRef: FieldRef;
        i: Integer;
        FieldNameClean: Text;
        FieldValueText: Text;
    begin
        ItemRecRef.GetTable(Item);

        // Prefer explicit brand/manufacturer fields over generic description text.
        for i := 1 to ItemRecRef.FieldCount() do begin
            FldRef := ItemRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if (FieldNameClean = 'brandcode') or
               (FieldNameClean = 'brandname') or
               (FieldNameClean = 'manufacturercode') or
               (FieldNameClean = 'manufacturername') then begin
                FieldValueText := Format(FldRef.Value);
                if FieldValueText <> '' then
                    exit(FieldValueText);
            end;
        end;

        for i := 1 to ItemRecRef.FieldCount() do begin
            FldRef := ItemRecRef.FieldIndex(i);
            FieldNameClean := CleanFieldName(FldRef.Name);
            if FieldNameClean.Contains('brand') or FieldNameClean.Contains('manufacturer') then begin
                FieldValueText := Format(FldRef.Value);
                if FieldValueText <> '' then
                    exit(FieldValueText);
            end;
        end;

        if Item."Description 2" <> '' then
            exit(Item."Description 2");

        exit('');
    end;

    local procedure NormalizeComparableText(InputText: Text): Text
    begin
        exit(UpperCase(DelChr(InputText, '=', ' -/.\,()[]{}')));
    end;

    local procedure CleanFieldName(FieldName: Text): Text
    begin
        exit(LowerCase(DelChr(DelChr(DelChr(FieldName, '=', ' '), '=', '.'), '=', '_')));
    end;

    local procedure EnsureDimensionValueExists(DimensionCode: Code[20]; ValueCode: Code[20])
    var
        Dimension: Record Dimension;
        DimValue: Record "Dimension Value";
    begin
        if (DimensionCode = '') or (ValueCode = '') then
            exit;
        if not Dimension.Get(DimensionCode) then
            exit;
        if not DimValue.Get(DimensionCode, ValueCode) then begin
            DimValue.Init();
            DimValue."Dimension Code" := DimensionCode;
            DimValue.Code := ValueCode;
            DimValue.Name := ValueCode;
            DimValue."Dimension Value Type" := DimValue."Dimension Value Type"::Standard;
            DimValue.Insert(true);
        end;
    end;

    local procedure CopyDefaultDimensionsFromItemCategory(var Item: Record Item; ItemCategoryCode: Code[20])
    var
        DefaultDimSource: Record "Default Dimension";
        DefaultDimTarget: Record "Default Dimension";
        DimensionCodeBrand: Code[20];
        DimensionCodeMainCat: Code[20];
        BrandValue: Code[20];
    begin
        if (Item."No." = '') or (ItemCategoryCode = '') then
            exit;

        // Copy setup template dimensions from Item Category if configured
        DefaultDimSource.Reset();
        DefaultDimSource.SetRange("Table ID", Database::"Item Category");
        DefaultDimSource.SetRange("No.", ItemCategoryCode);
        if DefaultDimSource.FindSet() then begin
            repeat
                if not DefaultDimTarget.Get(Database::Item, Item."No.", DefaultDimSource."Dimension Code") then begin
                    DefaultDimTarget.Init();
                    DefaultDimTarget."Table ID" := Database::Item;
                    DefaultDimTarget."No." := Item."No.";
                    DefaultDimTarget."Dimension Code" := DefaultDimSource."Dimension Code";
                    DefaultDimTarget.Validate("Dimension Value Code", DefaultDimSource."Dimension Value Code");
                    DefaultDimTarget.Validate("Value Posting", DefaultDimSource."Value Posting");
                    DefaultDimTarget.Insert(true);
                end;
            until DefaultDimSource.Next() = 0;
        end;

        // Add fallback/forced Dimensions: BRAND and MAIN CATEGORY to match target layout
        DimensionCodeBrand := 'BRAND';
        DimensionCodeMainCat := 'MAIN CATEGORY';
        BrandValue := GetItemBrandLikeText(Item);

        // 1. BRAND Dimension
        if (BrandValue <> '') and (BrandValue <> 'APSS') then begin
            EnsureDimensionValueExists(DimensionCodeBrand, CopyStr(BrandValue, 1, 20));
            if not DefaultDimTarget.Get(Database::Item, Item."No.", DimensionCodeBrand) then begin
                DefaultDimTarget.Init();
                DefaultDimTarget."Table ID" := Database::Item;
                DefaultDimTarget."No." := Item."No.";
                DefaultDimTarget."Dimension Code" := DimensionCodeBrand;
                DefaultDimTarget.Validate("Dimension Value Code", CopyStr(BrandValue, 1, 20));
                DefaultDimTarget.Validate("Value Posting", DefaultDimTarget."Value Posting"::"Same Code");
                DefaultDimTarget.Insert(true);
            end;
        end;

        // 2. MAIN CATEGORY Dimension
        if ItemCategoryCode <> '' then begin
            EnsureDimensionValueExists(DimensionCodeMainCat, ItemCategoryCode);
            if not DefaultDimTarget.Get(Database::Item, Item."No.", DimensionCodeMainCat) then begin
                DefaultDimTarget.Init();
                DefaultDimTarget."Table ID" := Database::Item;
                DefaultDimTarget."No." := Item."No.";
                DefaultDimTarget."Dimension Code" := DimensionCodeMainCat;
                DefaultDimTarget.Validate("Dimension Value Code", ItemCategoryCode);
                DefaultDimTarget.Validate("Value Posting", DefaultDimTarget."Value Posting"::"Same Code");
                DefaultDimTarget.Insert(true);
            end;
        end;
    end;

    procedure TriggerPoscoScrape(RfqNo: Text)
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        Url: Text;
        ContentText: Text;
        Content: HttpContent;
    begin
        Setup.GetSetupRecord();
        Setup.TestField("Middleware Base URL");

        Url := Setup."Middleware Base URL" + '/api/posco/scrape';
        if RfqNo <> '' then
            Url := Url + '?rfq_no=' + RfqNo;

        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', 'true');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");

        if not Client.Post(Url, Content, Response) then
            Error('Failed to connect to Middleware at %1', Url);

        if not Response.IsSuccessStatusCode() then begin
            Response.Content().ReadAs(ContentText);
            Error('Middleware returned error: %1', ContentText);
        end;

        Message('POSCO scraping started on Middleware server.\You can close this page. Click "Check Scrape Status" to monitor progress and fetch the results when done.');
    end;

    procedure CheckPoscoScrapeStatus()
    var
        IsRunning: Boolean;
        ProgressValue: Integer;
        StatusText: Text;
    begin
        if not GetScrapeStatusFromServer(IsRunning, ProgressValue, StatusText) then begin
            Message('Cannot connect to Middleware or retrieve status. Please check setup.');
            exit;
        end;

        if StatusText = 'WAITING_FOR_OTP' then begin
            Message('POSCO portal is requesting an OTP code.\The automated OTP listener (Power Automate) is currently processing it.\Please check status again in a minute.');
            exit;
        end;

        if IsRunning then begin
            Message('POSCO scraping is currently running.\Progress: %1%\Status: %2\You can check status again later.', Format(ProgressValue), StatusText);
        end else begin
            // Scraping is done - auto refresh the list
            FetchRfqList();
            if StatusText <> '' then
                Message('POSCO scraping completed!\Last status: %1\RFQ list has been refreshed.', StatusText)
            else
                Message('POSCO scraping is not currently running.\RFQ list has been refreshed.');
        end;
    end;


    local procedure GetScrapeStatusFromServer(var IsRunning: Boolean; var ProgressValue: Integer; var StatusText: Text): Boolean
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        Url: Text;
        ContentText: Text;
        JsonObj: JsonObject;
        Token: JsonToken;
    begin
        Setup.GetSetupRecord();
        if Setup."Middleware Base URL" = '' then
            exit(false);

        Url := Setup."Middleware Base URL" + '/api/posco/scrape/status';
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', 'true');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");

        if not Client.Get(Url, Response) then
            exit(false);

        if not Response.IsSuccessStatusCode() then
            exit(false);

        Response.Content().ReadAs(ContentText);
        if not JsonObj.ReadFrom(ContentText) then
            exit(false);

        IsRunning := false;
        ProgressValue := 0;
        StatusText := '';

        if JsonObj.Get('running', Token) then
            IsRunning := Token.AsValue().AsBoolean();
        if JsonObj.Get('progress', Token) then
            ProgressValue := Token.AsValue().AsInteger();
        if JsonObj.Get('status_text', Token) then
            StatusText := Token.AsValue().AsText();

        exit(true);
    end;

    local procedure PromptForPoscoOtp()
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        Url: Text;
        ContentText: Text;
        OtpCode: Text;
        Payload: JsonObject;
        PayloadText: Text;
        Content: HttpContent;
        ContentHeaders: HttpHeaders;
        OtpPage: Page "APSS POSCO OTP Input";
    begin
        Setup.GetSetupRecord();
        
        if OtpPage.RunModal() = Action::OK then begin
            OtpCode := OtpPage.GetOtpCode();
            if OtpCode <> '' then begin
                Url := Setup."Middleware Base URL" + '/api/posco/submit-otp';
                
                Payload.Add('otp', OtpCode);
                Payload.WriteTo(PayloadText);
                Content.WriteFrom(PayloadText);
                Content.GetHeaders(ContentHeaders);
                ContentHeaders.Clear();
                ContentHeaders.Add('Content-Type', 'application/json');
                
                Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', 'true');
                if Setup."API Key" <> '' then
                    Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
                    
                if Client.Post(Url, Content, Response) then begin
                    if not Response.IsSuccessStatusCode() then begin
                        Response.Content().ReadAs(ContentText);
                        Message('Failed to submit OTP: %1', ContentText);
                    end;
                end;
            end;
        end;
    end;

    procedure CancelPoscoScrape()
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        Url: Text;
        ContentText: Text;
        Content: HttpContent;
    begin
        Setup.GetSetupRecord();
        Setup.TestField("Middleware Base URL");
        
        Url := Setup."Middleware Base URL" + '/api/posco/cancel';
        
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', 'true');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
            
        if Client.Post(Url, Content, Response) then begin
            if Response.IsSuccessStatusCode() then
                Message('POSCO scraping successfully cancelled.')
            else begin
                Response.Content().ReadAs(ContentText);
                Error('Failed to cancel POSCO scraping: %1', ContentText);
            end;
        end;
    end;

    procedure UploadPttepExcel(FileName: Text; FileStream: InStream)
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        Url: Text;
        ContentText: Text;
        Content: HttpContent;
    begin
        Setup.GetSetupRecord();
        Setup.TestField("Middleware Base URL");
        
        Url := Setup."Middleware Base URL" + '/api/upload?live=true';
        
        Content.WriteFrom(FileStream);
        
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', 'true');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
            
        if not Client.Post(Url, Content, Response) then
            Error('Failed to connect to Middleware at %1', Url);
            
        if not Response.IsSuccessStatusCode() then begin
            Response.Content().ReadAs(ContentText);
            Error('Middleware returned error: %1', ContentText);
        end;
        
        Message('PTTEP Excel file uploaded successfully and import started in background.\Click "Check Import Status" to monitor progress.');
    end;

    procedure CheckPttepImportStatus()
    var
        IsRunning: Boolean;
        ProgressValue: Integer;
        StatusText: Text;
    begin
        if not GetPttepImportStatusFromServer(IsRunning, ProgressValue, StatusText) then begin
            Message('Cannot connect to Middleware or retrieve import status. Please check setup.');
            exit;
        end;

        if IsRunning then begin
            Message('PTTEP import process is currently running.\Progress: %1%\Status: %2\You can check status again later.', Format(ProgressValue), StatusText);
        end else begin
            // Import is done - auto refresh the list
            FetchRfqList();
            if StatusText <> '' then
                Message('PTTEP import completed!\Last status: %1\RFQ list has been refreshed.', StatusText)
            else
                Message('PTTEP import is not currently running.\RFQ list has been refreshed.');
        end;
    end;

    local procedure GetPttepImportStatusFromServer(var IsRunning: Boolean; var ProgressValue: Integer; var StatusText: Text): Boolean
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        Url: Text;
        ContentText: Text;
        JsonObj: JsonObject;
        ImportToken: JsonToken;
        Token: JsonToken;
    begin
        Setup.GetSetupRecord();
        if Setup."Middleware Base URL" = '' then
            exit(false);

        Url := Setup."Middleware Base URL" + '/api/pttep/import/status';
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', 'true');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");

        if not Client.Get(Url, Response) then
            exit(false);

        if not Response.IsSuccessStatusCode() then
            exit(false);

        Response.Content().ReadAs(ContentText);
        if JsonObj.ReadFrom(ContentText) then begin
            if JsonObj.Get('import', ImportToken) then begin
                if ImportToken.AsObject().Get('running', Token) then
                    IsRunning := Token.AsValue().AsBoolean();
                    
                if ImportToken.AsObject().Get('percent', Token) then
                    ProgressValue := Token.AsValue().AsInteger();
                    
                if ImportToken.AsObject().Get('stage', Token) then
                    StatusText := Token.AsValue().AsText();
                    
                exit(true);
            end;
        end;
        exit(false);
    end;


    procedure CancelPttepImport()
    var
        Setup: Record "APSS Integration Setup";
        Client: HttpClient;
        Response: HttpResponseMessage;
        Url: Text;
        ContentText: Text;
        Content: HttpContent;
    begin
        Setup.GetSetupRecord();
        Setup.TestField("Middleware Base URL");
        
        Url := Setup."Middleware Base URL" + '/api/pttep/cancel';
        
        Client.DefaultRequestHeaders().Add('ngrok-skip-browser-warning', 'true');
        if Setup."API Key" <> '' then
            Client.DefaultRequestHeaders().Add('x-api-key', Setup."API Key");
            
        if Client.Post(Url, Content, Response) then begin
            if Response.IsSuccessStatusCode() then
                Message('PTTEP import process successfully cancelled.')
            else begin
                Response.Content().ReadAs(ContentText);
                Error('Failed to cancel PTTEP import: %1', ContentText);
            end;
        end;
    end;

    local procedure ParseQtyTextToDecimal(QtyText: Text): Decimal
    var
        CleanedText: Text;
        i: Integer;
        C: Char;
        HasDecimalPoint: Boolean;
        ResultDec: Decimal;
    begin
        CleanedText := '';
        QtyText := DelChr(QtyText, '=', ','); // Strip commas
        QtyText := DelChr(QtyText, '<>', ' '); // Trim spaces
        
        HasDecimalPoint := false;
        for i := 1 to StrLen(QtyText) do begin
            C := QtyText[i];
            if (C >= '0') and (C <= '9') then
                CleanedText += Format(C)
            else if (C = '.') and (not HasDecimalPoint) then begin
                CleanedText += Format(C);
                HasDecimalPoint := true;
            end else begin
                if CleanedText <> '' then
                    break;
            end;
        end;

        if CleanedText = '' then
            exit(0);

        if StrLen(CleanedText) > 0 then
            if CleanedText[StrLen(CleanedText)] = '.' then
                CleanedText := CopyStr(CleanedText, 1, StrLen(CleanedText) - 1);

        if Evaluate(ResultDec, CleanedText) then
            exit(ResultDec);

        exit(0);
    end;
}
